import http from "node:http";
import https from "node:https";

// Hop-by-hop headers must never be forwarded in either direction (RFC 7230).
export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export function filterRequestHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "host" || lower === "content-length") continue;
    out[lower] = value;
  }
  return out;
}

export function filterResponseHeaders(rawHeaders) {
  const out = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const key = rawHeaders[i];
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "content-length") continue; // node recomputes when piping
    const value = rawHeaders[i + 1];
    if (out[lower] !== undefined) {
      out[lower] = Array.isArray(out[lower]) ? [...out[lower], value] : [out[lower], value];
    } else {
      out[lower] = value;
    }
  }
  return out;
}

// Raw byte forwarding with node:http(s).request — no fetch/undici in the path,
// so nothing is decoded, re-encoded, or re-serialized. Body must be a Buffer
// (replayable for failover) or a Readable (oversized stream-through, no replay).
export function sendUpstream({ origin, method, pathAndQuery, headers, body, timeoutMs }) {
  const url = new URL(pathAndQuery, origin);
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? https : http;

  const finalHeaders = filterRequestHeaders(headers);
  finalHeaders.host = url.host;
  if (Buffer.isBuffer(body)) {
    finalHeaders["content-length"] = body.length;
  } else if (body && !finalHeaders["transfer-encoding"]) {
    finalHeaders["transfer-encoding"] = "chunked";
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        method,
        path: url.pathname + url.search,
        headers: finalHeaders
      },
      res => resolve(res)
    );

    req.setTimeout(timeoutMs, () => {
      const err = new Error(`Upstream timeout after ${timeoutMs}ms`);
      err.code = "GROK_POOL_TIMEOUT";
      req.destroy(err);
    });

    req.on("error", reject);

    if (Buffer.isBuffer(body) && body.length) req.write(body);
    if (body === undefined || Buffer.isBuffer(body)) req.end();
  });
}

export function drainUpstream(res) {
  return new Promise(resolve => {
    res.resume();
    res.on("end", resolve);
    res.on("error", resolve);
    // hard cap drain wait
    setTimeout(resolve, 5_000).unref();
  });
}

export const RETRYABLE_STATUSES = new Set([401, 403, 408, 409, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(status);
}
