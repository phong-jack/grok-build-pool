// Web-dashboard OAuth login, replicating `grok login`'s loopback flow exactly
// (verified against the grok-build Rust source):
//   discovery -> PKCE S256 -> loopback listener -> authorize URL (full scopes,
//   including workspaces:*) -> code exchange (form-urlencoded) -> id_token
//   payload -> entry saved into the extra-accounts file as premium.
//
// The id_token signature is not verified here (no JWKS deps); it is only used
// to read email/user_id — the tokens themselves are validated by upstream on
// every use, which is what actually matters.

import http from "node:http";
import crypto from "node:crypto";

const XAI_ISSUER = "https://auth.x.ai";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
// default_oauth2_scopes() from the CLI source — workspaces:* is what makes
// accounts thinking-capable.
const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
  "conversations:read",
  "conversations:write",
  "workspaces:read",
  "workspaces:write"
];
const LOGIN_TTL_MS = 10 * 60_000;

const b64url = buf => Buffer.from(buf).toString("base64url");

let discoveryCache = null;
async function discover() {
  if (discoveryCache) return discoveryCache;
  const res = await fetch(`${XAI_ISSUER}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(10_000)
  });
  if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
  const doc = await res.json();
  if (!doc.authorization_endpoint || !doc.token_endpoint) throw new Error("OIDC discovery doc incomplete");
  discoveryCache = doc;
  return doc;
}

function generatePkce() {
  const code_verifier = b64url(crypto.randomBytes(32));
  const code_challenge = b64url(crypto.createHash("sha256").update(code_verifier).digest());
  return { code_verifier, code_challenge };
}

export function createLoginManager({ cfg, onAccountAdded }) {
  const logins = new Map(); // id -> login record

  async function start() {
    const discovery = await discover();
    const { code_verifier, code_challenge } = generatePkce();
    const state = crypto.randomUUID();
    const nonce = crypto.randomUUID();

    // Prefer the CLI's dev-contract port; fall back to an OS-assigned one
    // (RFC 8252 allows any loopback port, and production grok login uses random).
    let listener = null;
    let port = null;
    for (const candidate of [56121, 0]) {
      try {
        listener = http.createServer();
        await new Promise((resolve, reject) => {
          listener.once("error", reject);
          listener.listen(candidate, "127.0.0.1", resolve);
        });
        port = listener.address().port;
        break;
      } catch {
        listener?.close();
        listener = null;
      }
    }
    if (!listener) throw new Error("could not bind a loopback callback port");

    const redirect_uri = `http://127.0.0.1:${port}/callback`;
    const url =
      `${discovery.authorization_endpoint}?response_type=code` +
      `&client_id=${encodeURIComponent(CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
      `&scope=${encodeURIComponent(SCOPES.join(" "))}` +
      `&code_challenge=${encodeURIComponent(code_challenge)}` +
      `&code_challenge_method=S256` +
      `&state=${encodeURIComponent(state)}` +
      `&nonce=${encodeURIComponent(nonce)}`;

    const id = crypto.randomUUID();
    const login = {
      id,
      state,
      nonce,
      code_verifier,
      redirect_uri,
      authUrl: url,
      status: "pending",
      email: null,
      error: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + LOGIN_TTL_MS
    };
    logins.set(id, login);

    const cleanup = () => {
      try { listener.close(); } catch {}
    };

    listener.on("request", (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("not found");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const receivedState = url.searchParams.get("state") ?? "";

      const respond = html => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        cleanup();
      };

      if (error) {
        login.status = "error";
        login.error = `IdP: ${error} ${url.searchParams.get("error_description") ?? ""}`.trim();
        respond("<h2>✗ Login failed</h2><p>You can close this tab.</p>");
        return;
      }
      if (!code) {
        login.status = "error";
        login.error = "callback without code";
        respond("<h2>✗ Login failed</h2><p>Missing code parameter.</p>");
        return;
      }
      if (receivedState && receivedState !== login.state) {
        login.status = "error";
        login.error = "state mismatch";
        respond("<h2>✗ Login failed</h2><p>State mismatch — please retry.</p>");
        return;
      }

      exchangeCode(discovery.token_endpoint, code, login)
        .then(entry => {
          login.status = "complete";
          login.email = entry.email;
          login.account = entry;
          onAccountAdded?.(entry);
          respond(`<h2>✓ Login complete</h2><p>Saved <b>${entry.email}</b> to the pool as premium. You can close this tab.</p>`);
        })
        .catch(err => {
          login.status = "error";
          login.error = err.message;
          respond(`<h2>✗ Login failed</h2><p>${String(err.message).replace(/[<>&]/g, "")}</p>`);
        });
    });

    setTimeout(() => {
      if (login.status === "pending") {
        login.status = "expired";
        login.error = "login window timed out (10 minutes)";
        cleanup();
      }
    }, LOGIN_TTL_MS).unref();

    return { id, url: login.authUrl, redirect_uri, expires_at: new Date(login.expiresAt).toISOString() };
  }

  async function exchangeCode(tokenEndpoint, code, login) {
    const res = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-grok-client-version": cfg.headers.clientVersion
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: login.redirect_uri,
        client_id: CLIENT_ID,
        code_verifier: login.code_verifier
      }),
      signal: AbortSignal.timeout(20_000)
    });
    if (!res.ok) {
      throw new Error(`token exchange HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const tokens = await res.json();
    if (!tokens.access_token) throw new Error("token response has no access_token");

    // id_token payload (unverified decode — upstream validates on every use)
    let email = null;
    let userId = null;
    if (tokens.id_token) {
      try {
        const payload = JSON.parse(Buffer.from(tokens.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
        email = payload.email ?? null;
        userId = payload.sub ?? null;
      } catch {}
    }

    return {
      email: email ?? `user-${login.id.slice(0, 6)}`,
      userId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt: new Date(Date.now() + (Number(tokens.expires_in) || 21600) * 1000).toISOString()
    };
  }

  function status(id) {
    const login = logins.get(id);
    if (!login) return null;
    const { id: _i, state, nonce, code_verifier, redirect_uri, authUrl, ...safe } = login;
    return safe;
  }

  function cancel(id) {
    const login = logins.get(id);
    if (!login) return false;
    if (login.status === "pending") {
      login.status = "cancelled";
      login.error = "cancelled by user";
    }
    return true;
  }

  // periodic GC of finished logins
  setInterval(() => {
    const now = Date.now();
    for (const [id, login] of logins) {
      if (login.status !== "pending" && now - login.createdAt > 3_600_000) logins.delete(id);
    }
  }, 600_000).unref();

  return { start, status, cancel };
}
