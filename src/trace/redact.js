// Never let credentials reach disk (ndjson traces, wire dumps, fixtures).

const SECRET_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-xai-token-auth",
  "proxy-authorization"
]);

// Credential-shaped keys only — NOT things like max_output_tokens.
const SECRET_KEY_RE = /(access[-_]?token|refresh[-_]?token|id[-_]?token|^token$|authorization|cookie|secret|password|api[-_]?key)/i;

export function redactHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = SECRET_HEADERS.has(key.toLowerCase()) ? "***" : value;
  }
  return out;
}

export function redactValue(value, depth = 0) {
  if (depth > 12) return "...";
  if (Array.isArray(value)) return value.map(v => redactValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? "***" : redactValue(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && /^(sk-|Bearer\s)/i.test(value)) return "***";
  return value;
}

// Best-effort on raw text bodies: blank out long JWT-ish strings.
export function redactText(text) {
  return String(text)
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "***")
    .replace(/"((?:access|refresh|id)_?token|api[_-]?key|authorization)"\s*:\s*"[^"]*"/gi, '"$1":"***"');
}
