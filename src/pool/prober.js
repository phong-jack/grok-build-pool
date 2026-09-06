import https from "node:https";
import http from "node:http";
import { refreshAccountToken } from "../accounts/refresh.js";

// Periodically probe accounts that are not ACTIVE. A cheap authenticated GET
// proves the token still works and heals RATE_LIMITED / COOLDOWN / DEGRADED /
// AUTH_FAILED / DEAD accounts. On 401 the account's refresh token is exercised
// (the 6h access-token TTL makes this the pool's survival mechanism); a
// refreshed token is persisted as an override in pool.db.

function probeToken(origin, token, timeoutMs = 15_000) {
  return new Promise(resolve => {
    const url = new URL("/v1/models", origin);
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname,
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "x-xai-token-auth": "xai-grok-cli"
        }
      },
      res => {
        res.resume();
        res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ok: false, status: 0 });
    });
    req.on("error", () => resolve({ ok: false, status: 0 }));
    req.end();
  });
}

export function startProber({ pool, health, cfg, store }) {
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const candidates = pool.accounts().filter(a => a.isActive && !health.isUsable(a.id));
      for (const account of candidates) {
        let { ok, status } = await probeToken(cfg.upstreamOrigin, account.auth.accessToken);

        if (!ok && status === 401 && account.auth.refreshToken) {
          try {
            const fresh = await refreshAccountToken(account);
            account.auth.accessToken = fresh.accessToken;
            account.auth.refreshToken = fresh.refreshToken;
            account.auth.expiresAt = fresh.expiresAt;
            store?.saveTokenOverride(account.id, fresh);
            health.recordRefresh(account.id);
            const retried = await probeToken(cfg.upstreamOrigin, fresh.accessToken);
            ok = retried.ok;
            status = retried.status;
          } catch (error) {
            console.warn(`[prober] account ${account.label} refresh failed: ${error.message}`);
          }
        }

        if (ok) {
          health.recordSuccess(account.id);
          console.log(`[prober] account ${account.label} healed -> ACTIVE`);
        } else if (status === 401) {
          health.recordFailure(account.id, "auth", { message: "probe 401 after refresh attempt" });
        }
        await new Promise(r => setTimeout(r, 500)); // gentle pacing
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, cfg.healthProbeIntervalMs);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
