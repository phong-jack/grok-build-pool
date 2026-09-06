import https from "node:https";
import http from "node:http";
import { refreshAccountToken } from "../accounts/refresh.js";

// Periodically probe accounts that are not ACTIVE. A cheap authenticated GET
// proves the token still works and heals RATE_LIMITED / COOLDOWN / DEGRADED /
// AUTH_FAILED / DEAD accounts. On 401 the account's refresh token is exercised
// (the 6h access-token TTL makes this the pool's survival mechanism); a
// refreshed token is persisted as an override in pool.db.
//
// Additionally (AUTO_PREMIUM_PROBE, default on): a rotating subset of ACTIVE
// accounts gets a tiny streaming inference probe; any account observed to
// stream reasoning summaries is auto-promoted to premium (premium-first picks
// it up), and accounts that stop streaming are demoted again.

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

// Tiny streaming inference: resolves "THINKING" as soon as a summary delta is
// observed (connection destroyed right away — the answer itself doesn't matter).
// Returns "THINKING" | "NO" only for genuine completed responses — HTTP errors
// (429 throttle, 5xx...) return "HTTP <status>" so callers never demote an
// account based on a throttled probe.
export function probeSummaries(cfg, account) {
  return new Promise(resolve => {
    const body = JSON.stringify({
      model: "grok-4.6",
      input: "What is 9*9?",
      stream: true,
      reasoning: { summary: "concise" },
      include: ["reasoning.encrypted_content"],
      store: false,
      max_output_tokens: 300,
      temperature: 1
    });
    const url = new URL("/v1/responses", cfg.upstreamOrigin);
    const transport = url.protocol === "https:" ? https : http;
    const headers = {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      accept: "text/event-stream",
      authorization: `Bearer ${account.auth.accessToken}`,
      "x-xai-token-auth": "xai-grok-cli",
      "x-authenticateresponse": "authenticate-response",
      "x-grok-client-version": cfg.headers.clientVersion,
      "x-grok-client-identifier": cfg.headers.clientIdentifier,
      "x-grok-client-mode": cfg.headers.clientMode,
      "x-grok-model-override": "grok-4.6",
      "x-grok-has-grok-code-access": "true",
      "user-agent": `grok-shell/${cfg.headers.clientVersion} (windows; x86_64)`
    };
    if (account.auth.userId) headers["x-grok-user-id"] = account.auth.userId;
    if (account.auth.email) headers["x-email"] = account.auth.email;

    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const req = transport.request(
      { hostname: url.hostname, port: url.port || undefined, path: url.pathname, method: "POST", headers },
      res => {
        let raw = "";
        res.on("data", c => {
          raw += c.toString("latin1");
          if (raw.includes("reasoning_summary_text.delta")) {
            req.destroy();
            finish("THINKING");
          }
        });
        res.on("end", () => {
          if (res.statusCode !== 200) finish(`HTTP ${res.statusCode}`);
          else {
            const m = raw.match(/"status":"(completed|incomplete|failed)"/);
            finish(m ? m[1].toUpperCase() : "NO");
          }
        });
      }
    );
    req.on("error", e => finish(`ERR ${e.message}`));
    req.setTimeout(60_000, () => { req.destroy(); finish("timeout"); });
    req.write(body);
    req.end();
  });
}

export function startProber({ pool, health, cfg, store }) {
  let running = false;
  let probeCursor = 0;
  const BATCH = 5;

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

      // Auto-premium discovery: rotate through ACTIVE accounts, a few per tick.
      if (cfg.autoPremiumProbe) {
        const actives = pool.accounts().filter(a => a.isActive && health.isUsable(a.id));
        if (actives.length) {
          for (let i = 0; i < Math.min(BATCH, actives.length); i++) {
            const account = actives[probeCursor % actives.length];
            probeCursor = (probeCursor + 1) % Number.MAX_SAFE_INTEGER;
            const wasPremium = pool.isPremium(account);
            const result = await probeSummaries(cfg, account);
            if (result === "THINKING" || result === "NO") {
              pool.setSummaryCapability(account.id, result === "THINKING");
              if (!wasPremium && pool.isPremium(account)) {
                console.log(`[prober] account ${account.label} streams summaries -> auto-premium`);
              } else if (wasPremium && !pool.isPremium(account)) {
                console.log(`[prober] account ${account.label} no longer streams summaries -> demoted`);
              }
            }
            await new Promise(r => setTimeout(r, 700));
          }
        }
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, cfg.healthProbeIntervalMs);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
