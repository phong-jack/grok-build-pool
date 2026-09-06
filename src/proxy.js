import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { sendUpstream, drainUpstream, filterResponseHeaders, isRetryableStatus } from "./forward.js";
import { buildUpstreamHeaders } from "./identity.js";
import { refreshAccountToken } from "./accounts/refresh.js";
import { classifyRequest } from "./classify.js";

const WIRE = 2; // matches LEVEL_ORDER.wire in trace

function shortId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function writeJson(res, status, payload) {
  if (res.headersSent) { res.end(); return; }
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

// Bodies are buffered (replayable for failover). Beyond the limit the pool
// answers 413 itself — it never forwards a request it cannot retry.
async function readRequestBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return { overflow: true, size };
    chunks.push(chunk);
  }
  return { overflow: false, body: Buffer.concat(chunks), size };
}

function parseRetryAfterMs(headers) {
  const raw = headers?.["retry-after"];
  if (!raw) return null;
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

function kindForStatus(status) {
  if (status === 429) return "rate_limit";
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  return "server";
}

// Byte-stream tap: counts bytes/TTFB/SSE events and extracts response ids for
// the sticky index — the bytes forwarded to the client are never touched.
// Grok's Responses API uses bare-UUID ids (observed 2026-09: `"response":{...,"id":"<uuid>}"`)
// plus OpenAI-style prefixed ids; reasoning items are `rs_<uuid>`.
function createStreamTap({ onId, wireSink }) {
  const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const ID_PATTERNS = [
    new RegExp(`"response"\\s*:\\s*\\{[^{}]*?"id"\\s*:\\s*"(${UUID})"`, "g"),
    new RegExp(`"id"\\s*:\\s*"(${UUID})"[^{}]{0,300}"object"\\s*:\\s*"response"`, "g"),
    /"(?:id|response_id)"\s*:\s*"(resp_[A-Za-z0-9_-]+)"/g
  ];
  const tap = { bytes: 0, ids: new Set(), eventCount: 0, eventKinds: new Set() };
  let head = "";
  let tail = "";
  let lineBuf = "";
  const HEAD_CAP = 128 * 1024;
  const TAIL_CAP = 384 * 1024;

  tap.onChunk = chunk => {
    tap.bytes += chunk.length;
    const text = chunk.toString("latin1"); // ASCII patterns survive byte→char
    if (wireSink) wireSink(chunk);
    if (head.length < HEAD_CAP) head += text.slice(0, HEAD_CAP - head.length);
    tail = (tail + text).slice(-TAIL_CAP);
    lineBuf += text;
    let nl;
    while ((nl = lineBuf.indexOf("\n")) !== -1) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      if (line.startsWith("event:")) {
        tap.eventCount += 1;
        tap.eventKinds.add(line.slice(6).trim());
      }
    }
    const window = head.endsWith(tail.slice(0, 64)) ? head + tail : head + "\n" + tail;
    for (const re of ID_PATTERNS) {
      re.lastIndex = 0;
      for (const m of window.matchAll(re)) tap.ids.add(m[1]);
    }
    if (onId && tap.ids.size) {
      for (const id of tap.ids) { onId(id); }
      tap.ids.clear();
    }
  };
  return tap;
}

async function streamResponseToClient({ ctx, res, trace, upstreamRes, account, classification, startedAt, transformJson = null }) {
  const status = upstreamRes.statusCode;
  const respHeaders = filterResponseHeaders(upstreamRes.rawHeaders);
  const contentType = String(respHeaders["content-type"] ?? "");
  const isSse = contentType.includes("text/event-stream");

  // JSON patch path (e.g. /v1/user subscription tier): buffer, transform, send.
  if (transformJson && !isSse && contentType.includes("json")) {
    const chunks = [];
    for await (const c of upstreamRes) chunks.push(c);
    let body = Buffer.concat(chunks);
    let outHeaders = { ...respHeaders };
    let patched = false;
    try {
      const enc = String(upstreamRes.headers["content-encoding"] ?? "").toLowerCase();
      if (enc === "gzip") body = zlib.gunzipSync(body);
      else if (enc === "br") body = zlib.brotliDecompressSync(body);
      else if (enc === "deflate") body = zlib.inflateSync(body);
      const parsed = transformJson(JSON.parse(body.toString("utf8")));
      if (parsed) {
        body = Buffer.from(JSON.stringify(parsed));
        patched = true;
      }
      delete outHeaders["content-encoding"]; // sending the patched body plain
    } catch {
      // not JSON / decode failure — forward the original bytes untouched
      body = Buffer.concat(chunks);
      outHeaders = { ...respHeaders };
    }
    if (patched) trace.note({ json_patched: true });
    trace.response({ status, account, latencyMs: Date.now() - startedAt, ttfbMs: Date.now() - startedAt, bytesOut: body.length, stream: false, contentType });
    ctx.health.recordSuccess(account.id);
    ctx.store.insertRequest({
      id: trace.id, ts: trace.startedAt, method: trace.method, path: trace.record.path ?? trace.rawUrl,
      classification: trace.record.classification, model: trace.record.model, stream: false,
      account_id: account.id, account_label: account.label, account_email: account.email,
      status, latency_ms: Date.now() - startedAt, ttfb_ms: Date.now() - startedAt,
      bytes_in: trace.record.body_size ?? 0, bytes_out: body.length, attempts: trace.record.attempt,
      error: null, previous_response_id: classification.previousResponseId,
      session_id: classification.sessionId ?? classification.conversationId
    });
    await trace.end({ done: patched ? "ok+patched" : "ok" });
    res.writeHead(status, outHeaders);
    res.end(body);
    return { ok: true };
  }

  let wireSink = null;
  if (trace.trace.priority >= WIRE && trace.trace.stream) {
    try {
      const dir = path.join(trace.trace.dir, "wire", trace.id);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "res-stream.txt");
      let fd = null;
      wireSink = chunk => {
        try {
          fd = fd ?? fs.openSync(file, "a");
          fs.writeSync(fd, chunk);
        } catch {}
      };
    } catch {}
  }

  const tap = createStreamTap({ wireSink });
  let firstByteAt = null;
  let finished = false;

  trace.wireResponseHeaders(status, upstreamRes.headers);
  res.writeHead(status, respHeaders);

  const result = await new Promise(resolve => {
    const finish = info => {
      if (finished) return;
      finished = true;
      resolve(info);
    };
    const onData = chunk => {
      if (firstByteAt === null) firstByteAt = Date.now();
      tap.onChunk(chunk);
    };

    upstreamRes.on("data", onData);
    upstreamRes.pipe(res);

    upstreamRes.on("end", () => finish({ ok: true }));
    upstreamRes.on("aborted", () => {
      trace.streamError({ account, message: "upstream aborted", elapsedMs: Date.now() - startedAt, bytesSent: tap.bytes });
      if (!res.writableEnded) res.destroy();
      finish({ ok: false, error: new Error("upstream aborted") });
    });
    upstreamRes.on("error", error => {
      trace.streamError({ account, message: error.message, elapsedMs: Date.now() - startedAt, bytesSent: tap.bytes });
      if (!res.writableEnded) res.destroy();
      finish({ ok: false, error });
    });
    res.on("close", () => {
      if (!finished) {
        upstreamRes.destroy();
        finish({ ok: false, aborted: true });
      }
    });
  });

  const latencyMs = Date.now() - startedAt;
  const ttfbMs = firstByteAt !== null ? firstByteAt - startedAt : null;

  if (result.ok || result.aborted) {
    // client aborts are not the account's fault
    ctx.health.recordSuccess(account.id);
  } else {
    ctx.health.recordFailure(account.id, "network", { message: result.error?.message ?? "stream error" });
  }

  // Sticky bindings from observed response ids (inference state lives account-side);
  // session keys (path session uuid / conv / session headers) bind too.
  for (const id of tap.ids) ctx.sticky.bindResponse(id, account.id);
  const sessionKeys = [classification.pathSessionId, classification.sessionId, classification.conversationId].filter(Boolean);
  for (const key of sessionKeys) ctx.sticky.bindSession(key, account.id);

  trace.response({
    status,
    account,
    latencyMs,
    ttfbMs,
    bytesOut: tap.bytes,
    stream: isSse,
    contentType
  });
  if (isSse && tap.eventCount) {
    trace.note({ sse_event_count: tap.eventCount, sse_event_kinds: [...tap.eventKinds].slice(0, 60) });
  }

  ctx.store.insertRequest({
    id: trace.id,
    ts: trace.startedAt,
    method: trace.method,
    path: trace.record.path ?? trace.rawUrl,
    classification: trace.record.classification,
    model: trace.record.model,
    stream: isSse,
    account_id: account.id,
    account_label: account.label,
    account_email: account.email,
    status,
    latency_ms: latencyMs,
    ttfb_ms: ttfbMs,
    bytes_in: trace.record.body_size ?? 0,
    bytes_out: tap.bytes,
    attempts: trace.record.attempt,
    error: result.ok ? null : (result.error?.message ?? (result.aborted ? "client aborted" : "stream error")),
    previous_response_id: classification.previousResponseId,
    session_id: classification.sessionId ?? classification.conversationId
  });

  await trace.end({
    done: result.ok ? "ok" : result.aborted ? "client_aborted" : "stream_error",
    response_ids: [...tap.ids].slice(0, 20)
  });
  return result;
}

async function proxyWithFailover({ ctx, req, res, trace, body, classification, pathname }) {
  const maxAttempts = Math.max(1, ctx.cfg.maxFailovers + 1);
  let attemptsLeft = maxAttempts;
  const triedAccounts = new Set();
  const refreshed = new Set();
  let lastFailure = null;

  while (attemptsLeft > 0) {
    const pick = classification.cls === "METADATA"
      ? ctx.pool.pickMetadata({ classification, excludeIds: triedAccounts })
      : ctx.pool.pickFor({ classification, excludeIds: triedAccounts, allowFallback: true });
    const account = pick.account;
    if (!account) {
      writeJson(res, 503, {
        error: {
          type: "pool_unavailable",
          message: triedAccounts.size
            ? "No further accounts available after failover"
            : "No usable Grok accounts (all expired / rate-limited / dead)",
          tried: triedAccounts.size
        }
      });
      await trace.end({ done: "pool_unavailable", attempts: triedAccounts.size });
      return;
    }

    triedAccounts.add(account.id);
    attemptsLeft -= 1;
    trace.attempt({ n: trace.record.attempt + 1, account });
    ctx.pool.start(account);
    const startedAt = Date.now();

    try {
      const headers = buildUpstreamHeaders({ clientHeaders: req.headers, account, classification, cfg: ctx.cfg });
      trace.wireRequestHeaders(headers);
      if (body?.length) trace.wireRequestBody(body);

      let upstreamRes;
      try {
        upstreamRes = await sendUpstream({
          origin: ctx.cfg.upstreamOrigin,
          method: req.method,
          pathAndQuery: req.url,
          headers,
          body,
          timeoutMs: ctx.cfg.upstreamTimeoutMs
        });
      } catch (error) {
        lastFailure = error;
        trace.upstreamError({ account, error, elapsedMs: Date.now() - startedAt });
        ctx.health.recordFailure(
          account.id,
          error.code === "GROK_POOL_TIMEOUT" ? "timeout" : "network",
          { message: error.message }
        );
        continue;
      }

      const status = upstreamRes.statusCode;
      const elapsedMs = Date.now() - startedAt;

      if (isRetryableStatus(status)) {
        trace.upstreamStatus({ account, status, headers: upstreamRes.headers, elapsedMs, retryable: true });

        if (status === 401 && account.auth.refreshToken && !refreshed.has(account.id)) {
          refreshed.add(account.id);
          try {
            const fresh = await refreshAccountToken(account);
            account.auth.accessToken = fresh.accessToken;
            account.auth.refreshToken = fresh.refreshToken;
            account.auth.expiresAt = fresh.expiresAt;
            ctx.store.saveTokenOverride(account.id, fresh);
            ctx.health.recordRefresh(account.id);
            console.log(`[REQ ${trace.id.slice(0, 5)}]   token refreshed for ${account.label}; retrying same account`);
            await drainUpstream(upstreamRes);
            attemptsLeft += 1; // refresh-retry does not consume a failover slot
            triedAccounts.delete(account.id);
            continue;
          } catch (error) {
            ctx.health.recordFailure(account.id, "auth", { message: `refresh failed: ${error.message}` });
            await drainUpstream(upstreamRes);
            lastFailure = error;
            continue;
          }
        }

        ctx.health.recordFailure(account.id, kindForStatus(status), {
          retryAfterMs: status === 429 ? parseRetryAfterMs(upstreamRes.headers) : undefined,
          message: `HTTP ${status}`
        });
        await drainUpstream(upstreamRes);
        lastFailure = new Error(`HTTP ${status}`);
        continue;
      }

      // Terminal response — stream it back untouched (with the one narrow
      // /v1/user subscription patch so the CLI doesn't fall into Free tier).
      const transformJson =
        ctx.cfg.subscriptionTier && req.method === "GET" && pathname === "/v1/user"
          ? (j => {
              if (j && typeof j === "object" && "subscriptionTier" in j && (j.subscriptionTier === null || j.subscriptionTier === undefined)) {
                j.subscriptionTier = ctx.cfg.subscriptionTier;
              }
              return j;
            })
          : null;
      return await streamResponseToClient({ ctx, res, trace, upstreamRes, account, classification, startedAt, transformJson });
    } finally {
      ctx.pool.finish(account);
    }
  }

  writeJson(res, 502, {
    error: {
      type: "all_accounts_failed",
      message: "All accounts failed before a response could be streamed",
      cause: lastFailure?.message ?? null,
      tried: triedAccounts.size
    }
  });
  await trace.end({ done: "all_failed", attempts: triedAccounts.size });
}

export async function handleProxy({ ctx, req, res, pathname }) {
  const trace = ctx.trace.begin(shortId(), req.method, req.url);

  if (ctx.cfg.poolApiKey) {
    const provided = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (provided !== ctx.cfg.poolApiKey) {
      writeJson(res, 401, { error: { type: "pool_auth", message: "Invalid pool API key" } });
      return trace.end({ done: "rejected" });
    }
  }

  const isBody = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  let body;
  if (isBody) {
    const read = await readRequestBody(req, ctx.cfg.bodyLimit);
    if (read.overflow) {
      writeJson(res, 413, {
        error: {
          type: "body_too_large",
          message: `Request body exceeds BODY_LIMIT (${ctx.cfg.bodyLimit} bytes); the pool only forwards replayable requests`,
          received: read.size
        }
      });
      return trace.end({ done: "rejected_oversize" });
    }
    body = read.body;
  }

  const classification = classifyRequest({
    method: req.method,
    path: pathname,
    body,
    contentType: req.headers["content-type"] ?? "",
    headers: req.headers
  });

  trace.requestReceived({ classification, bodySize: body?.length ?? 0 });

  return proxyWithFailover({ ctx, req, res, trace, body, classification, pathname });
}
