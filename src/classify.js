// Read-only peek at the request. The body bytes themselves are forwarded untouched.

const METADATA_PATHS = [
  /^\/v1\/settings$/,
  /^\/v1\/login-config/,
  /^\/v1\/models/,
  /^\/v1\/subagents\//,
  /^\/v1\/user$/,
  /^\/v1\/billing/,
  /^\/v1\/usage/,
  /^\/v1\/features/
];

const INFERENCE_PATHS = [
  /^\/v1\/responses$/,
  /^\/v1\/chat\/completions$/,
  /^\/v1\/messages$/,
  /^\/v1\/completions$/
];

export function classifyRequest({ method, path, body, contentType, headers }) {
  const result = {
    cls: "UNKNOWN",
    known: false,
    model: null,
    stream: null,
    previousResponseId: null,
    sessionId: headers?.["x-grok-session-id"] || null,
    conversationId: headers?.["x-grok-conv-id"] || null,
    // CLI sessions carry their real id in the path: /v1/sessions/<uuid>/signals
    pathSessionId: path?.match(/^\/v1\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1] ?? null,
    userAgent: headers?.["user-agent"] ?? null
  };

  const pathKnown = METADATA_PATHS.some(re => re.test(path));
  const inferenceKnown = INFERENCE_PATHS.some(re => re.test(path));

  if (inferenceKnown) {
    result.cls = "INFERENCE";
    result.known = true;
  } else if (pathKnown) {
    result.cls = "METADATA";
    result.known = true;
  } else if (["GET", "HEAD", "OPTIONS"].includes(method)) {
    result.cls = "METADATA";
  } else {
    // Unknown POST-family endpoints are treated as inference for routing purposes;
    // traces keep cls=UNKNOWN semantics via known=false.
    result.cls = "INFERENCE";
  }

  // JSON peek (never forwarded from this parse).
  const isJson = typeof contentType === "string" && contentType.includes("json");
  if (isJson && body?.length) {
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.model === "string" && parsed.model) result.model = parsed.model;
        if (typeof parsed.stream === "boolean") result.stream = parsed.stream;
        if (typeof parsed.previous_response_id === "string" && parsed.previous_response_id) {
          result.previousResponseId = parsed.previous_response_id;
        }
      }
    } catch {
      // malformed json: forward as-is, no classification fields
    }
  }

  return result;
}
