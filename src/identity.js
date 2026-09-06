// Builds upstream headers: client headers win; the pool only fills gaps and
// overrides the identity that MUST match the selected account.

import { HOP_BY_HOP } from "./forward.js";

export function buildUpstreamHeaders({ clientHeaders, account, classification, cfg }) {
  const headers = {};

  for (const [key, value] of Object.entries(clientHeaders ?? {})) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "host" || lower === "content-length") continue;
    if (lower === "authorization") continue; // replaced per-account
    headers[lower] = Array.isArray(value) ? value.join(", ") : value;
  }

  const v = cfg.headers.clientVersion;

  // Fill-ins (only when the client did not send them).
  if (!headers["accept"]) headers["accept"] = "application/json, text/event-stream";
  if (!headers["user-agent"]) headers["user-agent"] = `grok-shell/${v} (windows; x86_64)`;
  if (!headers["x-grok-client-version"]) headers["x-grok-client-version"] = v;
  if (!headers["x-grok-client-identifier"]) headers["x-grok-client-identifier"] = cfg.headers.clientIdentifier;
  if (!headers["x-grok-client-mode"]) headers["x-grok-client-mode"] = cfg.headers.clientMode;
  if (!headers["x-xai-token-auth"]) headers["x-xai-token-auth"] = cfg.headers.tokenAuth;
  if (!headers["x-authenticateresponse"]) headers["x-authenticateresponse"] = "authenticate-response";
  if (!headers["x-grok-model-override"] && classification?.model) {
    headers["x-grok-model-override"] = classification.model;
  }
  if (!headers["x-grok-doom-loop-check"]) headers["x-grok-doom-loop-check"] = "1024";
  if (!headers["x-grok-exact-repetition-check"]) headers["x-grok-exact-repetition-check"] = "64";
  if (!headers["x-grok-session-id"] && classification?.sessionId) {
    headers["x-grok-session-id"] = classification.sessionId;
  }
  if (!headers["x-grok-conv-id"] && classification?.conversationId) {
    headers["x-grok-conv-id"] = classification.conversationId;
  }

  // Identity: always bound to the selected account.
  headers["authorization"] = `Bearer ${account.auth.accessToken}`;
  if (account.auth.userId) {
    headers["x-grok-user-id"] = account.auth.userId;
    // some clients (grok-pager) send the bare variant — never leak the origin user
    if (clientHeaders?.["x-userid"] !== undefined) headers["x-userid"] = account.auth.userId;
  }
  if (account.auth.email) headers["x-email"] = account.auth.email;
  if (account.auth.hasGrokCodeAccess !== undefined && !clientHeaders?.["x-grok-has-grok-code-access"]) {
    headers["x-grok-has-grok-code-access"] = String(Boolean(account.auth.hasGrokCodeAccess));
  }

  return headers;
}
