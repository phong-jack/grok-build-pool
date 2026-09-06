// OAuth refresh (ported from v2, generalized): 9Router stays read-only, so a
// refreshed token is persisted as an override in pool.db and preferred over the
// stored one until it too expires.

const DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const FALLBACK_TOKEN_URL = "https://auth.x.ai/oauth2/token";
// Grok CLI's OIDC client id (the UUID suffix of the auth.json issuer key).
export const GROK_CLI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const FALLBACK_CLIENT_ID = GROK_CLI_CLIENT_ID;

let cachedTokenEndpoint = null;

async function discoverTokenEndpoint() {
  if (cachedTokenEndpoint) return cachedTokenEndpoint;
  try {
    const res = await fetch(DISCOVERY_URL, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const doc = await res.json();
      if (typeof doc.token_endpoint === "string") {
        cachedTokenEndpoint = doc.token_endpoint;
        return cachedTokenEndpoint;
      }
    }
  } catch {}
  return null;
}

export async function refreshAccountToken(account, { clientId = FALLBACK_CLIENT_ID } = {}) {
  const refreshToken = account.auth.refreshToken;
  if (!refreshToken) throw new Error(`Account ${account.label ?? account.id} has no refreshToken`);

  const tokenUrl = (await discoverTokenEndpoint()) ?? FALLBACK_TOKEN_URL;

  // auth.x.ai's token endpoint only accepts form-urlencoded (JSON → HTTP 415).
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId
    }),
    signal: AbortSignal.timeout(20_000)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token refresh failed HTTP ${res.status} @ ${tokenUrl}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  if (!data.access_token) throw new Error("Token refresh response has no access_token");

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000).toISOString(),
    tokenEndpoint: tokenUrl
  };
}
