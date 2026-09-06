import "dotenv/config";
import { loadConfig } from "./config.js";
import { Trace } from "./trace/index.js";
import { AccountSource, isExpired } from "./accounts/source.js";
import { PoolStore } from "./store/db.js";
import { StickyIndex } from "./pool/sticky.js";
import { HealthTracker } from "./pool/health.js";
import { AccountPool } from "./pool/pool.js";
import { startProber } from "./pool/prober.js";
import { createAdminHandler } from "./admin/api.js";
import { createServer } from "./server.js";

const cfg = loadConfig();

const trace = new Trace(cfg.trace);
// refreshed-token overrides: pool.db is the store, this map keeps them hot
// across source cache rebuilds (prober/proxy refreshes update it on save)
const tokenOverrides = new Map();
const source = new AccountSource({ dbPath: cfg.routerDbPath, ttlMs: cfg.accountsTtlMs, extraPath: cfg.accountsExtraPath, overrides: tokenOverrides });
const store = new PoolStore(cfg.poolDbPath, { retentionDays: cfg.requestRetentionDays });
const sticky = new StickyIndex({ store, ttlMs: cfg.stickyTtlMs });
const health = new HealthTracker({ store });
const pool = new AccountPool({ source, sticky, health, strategy: cfg.strategy, premiumModels: cfg.premiumModels });

// load persisted overrides (from previous sessions' refreshes) into the hot map
for (const rowState of store.loadAccountStates()) {
  if (!rowState.token_override) continue;
  if (Date.parse(rowState.token_override_expires_at ?? "") > Date.now() + 30_000) {
    tokenOverrides.set(rowState.account_id, {
      accessToken: rowState.token_override,
      refreshToken: rowState.token_override_refresh,
      expiresAt: rowState.token_override_expires_at
    });
  }
}

// keep the hot map in sync whenever a refresh is saved
const _saveTokenOverride = store.saveTokenOverride.bind(store);
store.saveTokenOverride = (accountId, tokens) => {
  if (tokens.expiresAt && Date.parse(tokens.expiresAt) > Date.now() + 30_000) {
    tokenOverrides.set(accountId, tokens);
  } else {
    tokenOverrides.delete(accountId);
  }
  return _saveTokenOverride(accountId, tokens);
};

// sanity: apply overrides to the initial cached accounts
source.refresh(true);

const ctx = { cfg, trace, source, store, sticky, health, pool };
ctx.admin = createAdminHandler({ ctx });

const server = createServer({ ctx });

setInterval(() => sticky.prune(), 300_000).unref();
setInterval(() => store.prune(), 3_600_000).unref();
const prober = startProber({ pool, health, cfg, store });
// first probe pass shortly after boot so stale states don't linger
setTimeout(() => prober.tick(), 10_000).unref();

server.listen(cfg.port, cfg.host, () => {
  const accounts = pool.accounts();
  const usable = accounts.filter(a => a.isActive && !isExpired(a.auth) && health.isUsable(a.id)).length;
  const expired = accounts.filter(a => isExpired(a.auth)).length;
  console.log(`
grok-pool v${cfg.version} — transparent gateway
  local:     http://${cfg.host}:${cfg.port}
  upstream:  ${cfg.upstreamOrigin} (path+query forwarded verbatim)
  accounts:  ${accounts.length} total / ${usable} usable / ${expired} expired-token
  strategy:  ${cfg.strategy}, failover attempts: ${cfg.maxFailovers + 1}
  sticky:    ${sticky.size().responses} response bindings, ${sticky.size().sessions} session bindings
  trace:     ${trace.level} -> ${cfg.trace.dir}
  dashboard: http://${cfg.host}:${cfg.port}/dashboard
`);
  if (!accounts.length) {
    console.warn(`  !! no grok-cli accounts found in ${cfg.routerDbPath}`);
  } else if (!usable) {
    console.warn("  !! no usable accounts (tokens expired / all cooling down) — refresh will be attempted on first request");
  }
});

function shutdown() {
  console.log("\n[pool] shutting down...");
  server.close(() => {
    source.close();
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
