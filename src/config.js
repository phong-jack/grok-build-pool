import fs from "node:fs";
import path from "node:path";

const V3_DEFAULT_ROUTER_DB = "C:\\Users\\ngoti\\AppData\\Roaming\\9router\\db\\data.sqlite";

function bytes(value, fallback) {
  if (!value) return fallback;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(value).trim());
  if (!m) return fallback;
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(m[2] ?? "b").toLowerCase()];
  return Math.floor(Number(m[1]) * mult);
}

// UPSTREAM_BASE_URL (v3 legacy, includes /v1) is accepted and reduced to an origin.
function resolveOrigin(env) {
  if (env.UPSTREAM_ORIGIN) return env.UPSTREAM_ORIGIN.replace(/\/+$/, "");
  if (env.UPSTREAM_BASE_URL) return env.UPSTREAM_BASE_URL.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  return "https://cli-chat-proxy.grok.com";
}

const TRACE_LEVELS = { info: 0, debug: 1, wire: 2 };

export function loadConfig(env = process.env) {
  const cfg = {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 20129),
    upstreamOrigin: resolveOrigin(env),
    upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS ?? 300_000),
    bodyLimit: bytes(env.BODY_LIMIT, 25 * 1024 * 1024),
    routerDbPath: env.ROUTER_DB_PATH ?? V3_DEFAULT_ROUTER_DB,
    // Optional extra accounts JSON (array of {email,userId,accessToken,refreshToken,expiresAt}),
    // merged into the pool on top of the read-only 9Router rows.
    accountsExtraPath: env.ACCOUNTS_EXTRA_JSON
      ? path.resolve(env.ACCOUNTS_EXTRA_JSON)
      : path.join(path.dirname(path.resolve(env.POOL_DB_PATH ?? "./data/pool.db")), "accounts.extra.json"),
    poolDbPath: path.resolve(env.POOL_DB_PATH ?? "./data/pool.db"),
    strategy: env.POOL_STRATEGY ?? "round-robin",
    maxFailovers: Number(env.MAX_FAILOVERS ?? 4),
    stickyTtlMs: Number(env.STICKY_TTL_MS ?? 3_600_000),
    healthProbeIntervalMs: Number(env.HEALTH_PROBE_INTERVAL_MS ?? 600_000),
    // Probe ACTIVE accounts for reasoning-summary capability and auto-promote
    // accounts that stream summaries (premium-first picks them up automatically).
    autoPremiumProbe: (env.AUTO_PREMIUM_PROBE ?? "true") !== "false",
    requestRetentionDays: Number(env.REQUEST_RETENTION_DAYS ?? 7),
    poolApiKey: env.POOL_API_KEY ?? "",
    trace: {
      level: TRACE_LEVELS[(env.GROK_TRACE ?? "info").toLowerCase()] !== undefined
        ? (env.GROK_TRACE ?? "info").toLowerCase()
        : "info",
      body: (env.GROK_TRACE_BODY ?? "false") === "true",
      headers: (env.GROK_TRACE_HEADERS ?? "true") === "true",
      stream: (env.GROK_TRACE_STREAM ?? "true") === "true",
      dir: path.resolve(env.TRACE_DIR ?? "./traces")
    },
    headers: {
      clientVersion: env.GROK_CLIENT_VERSION ?? "1.0.13",
      tokenAuth: env.GROK_TOKEN_AUTH ?? "xai-grok-cli",
      clientIdentifier: env.GROK_CLIENT_IDENTIFIER ?? "grok-shell",
      clientMode: env.GROK_CLIENT_MODE ?? "interactive"
    },
    defaultModel: env.DEFAULT_MODEL ?? "grok-4.5",
    // Upstream never exposes a subscription tier on /v1/user (always null) — the CLI
    // reads that as "Free", hides thinking and shows an upgrade banner. Setting a
    // non-null tier here patches ONLY that field on /v1/user responses; empty = off.
    subscriptionTier: env.GROK_POOL_SUBSCRIPTION_TIER ?? "SuperGrok",
    accountsTtlMs: Number(env.ACCOUNTS_TTL_MS ?? 30_000),
    loginRoot: env.LOGIN_ROOT ?? "./.grok-logins",
    version: "4.0.0"
  };
  return cfg;
}
