import fs from "node:fs";
import path from "node:path";
import { redactHeaders, redactValue, redactText } from "./redact.js";

const LEVEL_ORDER = { info: 0, debug: 1, wire: 2 };

function fmtBytes(n) {
  if (n == null) return "?";
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 ** 2).toFixed(2)}MB`;
}

function fmtMs(ms) {
  if (ms == null) return "?";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// Append-only ndjson writer that never blocks the request path on errors.
class NdjsonWriter {
  constructor(file) {
    this.file = file;
    this.queue = Promise.resolve();
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  write(obj) {
    const line = JSON.stringify(obj) + "\n";
    this.queue = this.queue
      .then(() => fs.promises.appendFile(this.file, line))
      .catch(() => {});
    return this.queue;
  }
  async flush() {
    await this.queue;
  }
}

// One RequestTrace per proxied request. Console mirrors what the user sees;
// traces/requests.ndjson gets the structured record; wire/ gets raw dumps.
export class Trace {
  constructor({ dir, level = "info", body = false, headers = true, stream = true }) {
    this.dir = dir;
    this.level = level;
    this.body = body;
    this.headers = headers;
    this.stream = stream;
    this.ndjson = new NdjsonWriter(path.join(dir, "requests.ndjson"));
  }

  get priority() {
    return LEVEL_ORDER[this.level] ?? 0;
  }

  configure({ level, body, headers, stream }) {
    if (level && LEVEL_ORDER[level] !== undefined) this.level = level;
    if (body !== undefined) this.body = Boolean(body);
    if (headers !== undefined) this.headers = Boolean(headers);
    if (stream !== undefined) this.stream = Boolean(stream);
  }

  begin(id, method, rawUrl) {
    return new RequestTrace(this, id, method, rawUrl);
  }

  config() {
    return { level: this.level, body: this.body, headers: this.headers, stream: this.stream, dir: this.dir };
  }
}

export class RequestTrace {
  constructor(trace, id, method, rawUrl) {
    this.trace = trace;
    this.id = id;
    this.method = method;
    this.rawUrl = rawUrl;
    this.startedAt = Date.now();
    this.record = {
      id,
      ts: new Date(this.startedAt).toISOString(),
      method,
      url: rawUrl,
      attempt: 0
    };
    this.wireDir = null;
    this.ended = false;
  }

  #consoleInfo(msg) {
    console.log(`[REQ ${this.id.slice(0, 5)}] ${msg}`);
  }

  #consoleDebug(msg) {
    if (this.trace.priority >= LEVEL_ORDER.debug) console.log(`[REQ ${this.id.slice(0, 5)}]   ${msg}`);
  }

  requestReceived({ classification, bodySize, clientIp }) {
    Object.assign(this.record, {
      path: this.record.url,
      classification: classification?.cls ?? null,
      known: classification?.known ?? null,
      model: classification?.model ?? null,
      stream_request: classification?.stream ?? null,
      previous_response_id: classification?.previousResponseId ?? null,
      session_id: classification?.sessionId ?? null,
      body_size: bodySize ?? 0,
      client_ip: clientIp ?? null
    });
    const size = bodySize ? ` ${fmtBytes(bodySize)}` : "";
    this.#consoleInfo(`>>> ${this.method} ${this.record.url} [${classification?.cls ?? "?"}]${size}`);
    this.#consoleDebug(
      `model=${classification?.model ?? "-"} stream=${classification?.stream ?? "-"} prev_id=${classification?.previousResponseId ?? "-"}`
    );
  }

  attempt({ n, account }) {
    this.record.attempt = n;
    if (account) {
      this.record.account_id = account.id;
      this.record.account_label = account.label;
      this.record.account_email = account.email;
    }
    this.#consoleInfo(`attempt #${n} -> account ${account?.label ?? "?"} (${account?.email ?? "?"})`);
  }

  upstreamError({ account, error, elapsedMs }) {
    this.#consoleInfo(`!!  account ${account?.label ?? "?"} error: ${error.message} (${fmtMs(elapsedMs)})`);
    this.lastUpstreamError = { account: account?.label, message: error.message, code: error.code ?? null, elapsedMs };
  }

  upstreamStatus({ account, status, headers, elapsedMs, retryable }) {
    if (retryable) {
      this.#consoleInfo(`<<  ${status} from ${account?.label ?? "?"} (retryable, ${fmtMs(elapsedMs)})`);
    }
    if (this.trace.priority >= LEVEL_ORDER.debug) {
      this.record.upstream_status = status;
    }
    if (this.trace.headers) this.wireDump("res-headers", status, redactHeaders(headers));
  }

  wireDump(kind, ...args) {
    if (this.trace.priority < LEVEL_ORDER.wire) return;
    try {
      if (!this.wireDir) {
        this.wireDir = path.join(this.trace.dir, "wire", this.id);
        fs.mkdirSync(this.wireDir, { recursive: true });
      }
      const [payload] = args.slice(-1);
      const name = `${kind}.json`;
      fs.writeFileSync(path.join(this.wireDir, name), JSON.stringify(payload, null, 2));
    } catch {}
  }

  wireRequestHeaders(headers) {
    if (!this.trace.headers) return;
    this.wireDump("req-headers", redactHeaders(headers));
  }

  wireRequestBody(body) {
    if (!this.trace.body) return;
    try {
      const text = body.toString("utf8");
      const parsed = JSON.parse(text);
      this.wireDump("req-body", redactValue(parsed));
    } catch {
      if (body?.length) this.wireDump("req-body", redactText(body.toString("utf8").slice(0, 64_000)));
    }
  }

  wireResponseHeaders(status, headers) {
    if (!this.trace.headers) return;
    this.wireDump("res-headers", { status, headers: redactHeaders(headers) });
  }

  wireChunk(_chunk) {
    // Chunk bodies are captured by the stream tap only when body tracing is on;
    // handled in proxy.js via wireStreamFile().
  }

  streamEvent({ event, bytes, deltaMs }) {
    if (!this.trace.stream || this.trace.priority < LEVEL_ORDER.debug) return;
    if (!this._events) this._events = [];
    this._events.push({ event, bytes, deltaMs });
  }

  streamError({ account, message, elapsedMs, bytesSent }) {
    this.#consoleInfo(`!!  STREAM_ERROR account=${account?.label ?? "?"} elapsed=${fmtMs(elapsedMs)} error=${message}`);
    this.record.stream_error = { account: account?.label ?? null, message, elapsedMs, bytes_sent: bytesSent ?? null };
  }

  response({ status, account, latencyMs, ttfbMs, bytesIn, bytesOut, stream, contentType }) {
    Object.assign(this.record, {
      status,
      latency_ms: latencyMs,
      ttfb_ms: ttfbMs ?? null,
      bytes_in: bytesIn ?? null,
      bytes_out: bytesOut ?? null,
      stream_response: stream ?? null,
      content_type: contentType ?? null
    });
    const kind = stream ? "stream" : "json";
    this.#consoleInfo(
      `<<< ${status} ${fmtMs(latencyMs)} ${kind} ${fmtBytes(bytesOut)}${account ? ` via ${account.label}` : ""}`
    );
  }

  note(fields) {
    Object.assign(this.record, fields);
  }

  async end(extra = {}) {
    if (this.ended) return;
    this.ended = true;
    Object.assign(this.record, extra, { latency_ms_total: Date.now() - this.startedAt });
    if (this._events?.length && this.trace.priority >= LEVEL_ORDER.debug) {
      this.record.sse_events = this._events.slice(-200);
      this.record.sse_event_count = this._events.length;
    }
    if (this.lastUpstreamError && !this.record.upstream_error) {
      this.record.upstream_error = this.lastUpstreamError;
    }
    this.#consoleInfo(`=== done in ${fmtMs(this.record.latency_ms_total)}`);
    await this.trace.ndjson.write(redactValue(this.record));
  }
}
