// Peek at the request. JSON /v1 inference bodies get stream:true injected
// unless the client explicitly set stream:false; other bytes stay untouched.

const METADATA_PATHS = [
  /^\/v1\/settings$/,
  /^\/v1\/login-config/,
  /^\/v1\/models/,
  /^\/v1\/subagents\//,
  /^\/v1\/user$/,
  /^\/v1\/billing/,
  /^\/v1\/usage/,
  /^\/v1\/features/,
];

const INFERENCE_PATHS = [
  /^\/v1\/responses$/,
  /^\/v1\/chat\/completions$/,
  /^\/v1\/messages$/,
  /^\/v1\/completions$/,
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
    pathSessionId:
      path?.match(
        /^\/v1\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
      )?.[1] ?? null,
    userAgent: headers?.["user-agent"] ?? null,
  };

  const pathKnown = METADATA_PATHS.some((re) => re.test(path));
  const inferenceKnown = INFERENCE_PATHS.some((re) => re.test(path));

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
  const isJson =
    typeof contentType === "string" && contentType.includes("json");
  if (isJson && body?.length) {
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.model === "string" && parsed.model)
          result.model = parsed.model;
        if (typeof parsed.stream === "boolean") result.stream = parsed.stream;
        if (
          typeof parsed.previous_response_id === "string" &&
          parsed.previous_response_id
        ) {
          result.previousResponseId = parsed.previous_response_id;
        }
      }
    } catch {
      // malformed json: forward as-is, no classification fields
    }
  }

  return result;
}

function isJsonContentType(contentType) {
  return typeof contentType === "string" && contentType.includes("json");
}

function isV1Path(path) {
  return (
    typeof path === "string" && (path === "/v1" || path.startsWith("/v1/"))
  );
}

function wantsStreamDefault(parsed) {
  // Explicit false is the only opt-out. Missing / null / "true" / 1 all become true.
  if (parsed.stream === false) return false;
  return true;
}

// Default stream:true on JSON /v1 bodies so upstream always streams unless the
// client set stream:false. Returns the original Buffer when nothing changes.
// Default stream:true on JSON /v1 bodies so upstream always streams unless the
// client set stream:false. Returns the original Buffer when nothing changes.

export function ensureStreamTrue({ path, body, contentType }) {
  if (!body?.length || !isV1Path(path) || !isJsonContentType(contentType)) {
    return { body, injected: false, stream: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { body, injected: false, stream: null };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { body, injected: false, stream: null };
  }

  let changed = false;

  // Default stream:true
  if (parsed.stream !== true && wantsStreamDefault(parsed)) {
    parsed.stream = true;
    changed = true;
  }

  // Default reasoning
  if (
    !parsed.reasoning ||
    typeof parsed.reasoning !== "object" ||
    Array.isArray(parsed.reasoning)
  ) {
    parsed.reasoning = {};
    changed = true;
  }

  if (parsed.reasoning.effort == null) {
    parsed.reasoning.effort = "high";
    changed = true;
  }

  if (parsed.reasoning.summary == null) {
    parsed.reasoning.summary = "detailed";
    changed = true;
  }

  // Request encrypted reasoning content
  if (!Array.isArray(parsed.include)) {
    parsed.include = ["reasoning.encrypted_content"];
    changed = true;
  } else if (!parsed.include.includes("reasoning.encrypted_content")) {
    parsed.include.push("reasoning.encrypted_content");
    changed = true;
  }

  if (!changed) {
    return {
      body,
      injected: false,
      stream: parsed.stream ?? null,
    };
  }

  return {
    body: Buffer.from(JSON.stringify(parsed)),
    injected: true,
    stream: parsed.stream ?? null,
  };
}
