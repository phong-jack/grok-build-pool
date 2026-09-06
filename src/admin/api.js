// Local admin API under /pool/* — never forwarded upstream.
// Manages the extra/premium account file (data/accounts.extra.json):
//   GET    /pool/premium                 list premium-capable management entries
//   POST   /pool/premium                 add/replace an account (accepts a raw auth.json paste)
//   DELETE /pool/premium/<id-or-email>   remove it from the extra file
//   POST   /pool/premium/check/<id>      run a live reasoning-summary probe now
//   POST   /pool/export-accounts         sync freshest tokens from pool.db into the file

import { addExtraAccount, loadExtraFile, removeExtraAccount, syncExtraFromOverrides } from "../accounts/extra.js";
import { probeSummaries } from "../pool/prober.js";
import { createLoginManager } from "../auth/login-flow.js";

// web-dashboard OAuth login manager (adds premium accounts without the CLI).
// deps are wired lazily in bindLoginDeps() because this module initializes
// before the ctx exists.
let cfgAccountsExtraPath = null;
let sourceRefresh = null;
const loginCfg = { headers: { clientVersion: "1.0.13" } };
const loginManager = createLoginManager({
  cfg: loginCfg,
  onAccountAdded: entry => {
    if (!cfgAccountsExtraPath) return;
    addExtraAccount(cfgAccountsExtraPath, { ...entry, premium: true });
    sourceRefresh?.(true);
  }
});

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

function previewToken(token) {
  return token ? `${String(token).slice(0, 10)}…(${String(token).length})` : null;
}

// Accepts either a ready-to-use entry {email, accessToken, ...} or a pasted
// auth.json (issuer-keyed object) — picks the first usable credential entry.
function normalizeAccountInput(input) {
  let src = input;
  if (input && typeof input === "object" && !input.accessToken && !input.key) {
    const candidates = Object.values(input).filter(v => v && typeof v === "object" && (v.key || v.accessToken || v.access_token));
    src = candidates[0];
  }
  if (!src) return null;
  const accessToken = src.accessToken ?? src.key ?? src.access_token;
  const email = src.email;
  if (!accessToken || !email) return null;
  return {
    email,
    userId: src.userId ?? src.user_id ?? null,
    accessToken,
    refreshToken: src.refreshToken ?? src.refresh_token ?? null,
    expiresAt: src.expiresAt ?? src.expires_at ?? null,
    premium: input.premium ?? true
  };
}

function premiumList(ctx) {
  const fileEntries = loadExtraFile(ctx.cfg.accountsExtraPath);
  const accounts = ctx.source.all().filter(a => a.id.startsWith("extra-"));
  const byEmail = new Map(accounts.map(a => [a.email, a]));
  return {
    file: ctx.cfg.accountsExtraPath,
    auto_premium_ids: [...ctx.pool.autoPremium],
    accounts: fileEntries.map((e, i) => {
      const live = byEmail.get(e.email);
      const status = live ? ctx.health.effectiveStatus(live.id) : "NOT-LOADED";
      return {
        id: live?.id ?? `extra-${String(i).padStart(2, "0")}-${e.email}`,
        label: live?.label ?? null,
        email: e.email,
        status,
        has_summaries: live ? ctx.pool.isPremium(live) : false,
        premium_flag: Boolean(e.premium),
        token_expires_at: e.expiresAt ?? null,
        token_preview: previewToken(e.accessToken),
        has_refresh_token: Boolean(e.refreshToken)
      };
    })
  };
}

export function createAdminHandler({ ctx }) {
  cfgAccountsExtraPath = ctx.cfg.accountsExtraPath;
  sourceRefresh = r => ctx.source.refresh(r);
  loginCfg.headers.clientVersion = ctx.cfg.headers.clientVersion;
  return async function handleAdmin(req, res, pathname, query) {
    const { pool, store, trace, sticky } = ctx;

    if (req.method === "GET" && pathname === "/pool/health") {
      const accounts = pool.summary();
      const by = {};
      for (const a of accounts) by[a.status] = (by[a.status] ?? 0) + 1;
      return json(res, 200, {
        ok: true,
        version: ctx.cfg.version,
        uptime_s: Math.round(process.uptime()),
        upstream: ctx.cfg.upstreamOrigin,
        strategy: ctx.cfg.strategy,
        trace: trace.config(),
        sticky: sticky.size(),
        accounts_total: accounts.length,
        accounts_by_status: by
      });
    }

    if (req.method === "GET" && pathname === "/pool/accounts") {
      if (query.get("refresh") === "1") ctx.source.refresh(true);
      return json(res, 200, { source: ctx.cfg.routerDbPath, accounts: pool.summary() });
    }

    if (req.method === "GET" && pathname === "/pool/requests") {
      const limit = Math.min(Number(query.get("limit") ?? 100) || 100, 500);
      return json(res, 200, { requests: store.recentRequests(limit) });
    }

    const requestMatch = pathname.match(/^\/pool\/requests\/([A-Za-z0-9_-]+)$/);
    if (req.method === "GET" && requestMatch) {
      const rec = store.getRequest(requestMatch[1]);
      if (!rec) return json(res, 404, { error: { message: "request not found" } });
      return json(res, 200, { request: rec });
    }

    if (req.method === "GET" && pathname === "/pool/stats") {
      return json(res, 200, { ...store.stats(), in_flight: [...pool.inFlight.values()].reduce((a, b) => a + b, 0) });
    }

    if (req.method === "GET" && pathname === "/pool/config") {
      return json(res, 200, { trace: trace.config(), cfg: {
        upstream: ctx.cfg.upstreamOrigin,
        strategy: ctx.cfg.strategy,
        max_failovers: ctx.cfg.maxFailovers,
        body_limit: ctx.cfg.bodyLimit,
        sticky_ttl_ms: ctx.cfg.stickyTtlMs,
        pool_api_key_required: Boolean(ctx.cfg.poolApiKey)
      } });
    }

    if (req.method === "POST" && pathname === "/pool/config") {
      const input = await readJson(req);
      trace.configure(input.trace ?? input);
      return json(res, 200, { trace: trace.config() });
    }

    // --- premium account management ---

    if (req.method === "GET" && pathname === "/pool/premium") {
      return json(res, 200, premiumList(ctx));
    }

    if (req.method === "POST" && pathname === "/pool/premium") {
      const input = await readJson(req);
      const entry = normalizeAccountInput(input.auth ?? input);
      if (!entry) {
        return json(res, 400, { error: { message: "need email + accessToken (or paste a valid auth.json as `auth`)" } });
      }
      addExtraAccount(ctx.cfg.accountsExtraPath, entry);
      ctx.source.refresh(true);
      return json(res, 200, premiumList(ctx));
    }

    const premiumCheck = pathname.match(/^\/pool\/premium\/check\/(.+)$/);
    if (req.method === "POST" && premiumCheck) {
      const key = decodeURIComponent(premiumCheck[1]);
      const account = ctx.source.all().find(a => a.id === key || a.email === key);
      if (!account) return json(res, 404, { error: { message: `account ${key} not loaded` } });
      const result = await probeSummaries(ctx.cfg, account);
      if (result === "THINKING" || result === "NO") ctx.pool.setSummaryCapability(account.id, result === "THINKING");
      return json(res, 200, { id: account.id, email: account.email, result, has_summaries: ctx.pool.isPremium(account) });
    }

    const premiumDelete = pathname.match(/^\/pool\/premium\/(.+)$/);
    if (req.method === "DELETE" && premiumDelete) {
      const key = decodeURIComponent(premiumDelete[1]);
      const { removed } = removeExtraAccount(ctx.cfg.accountsExtraPath, key);
      ctx.source.refresh(true);
      if (!removed) return json(res, 404, { error: { message: `${key} not found in extra file` } });
      return json(res, 200, premiumList(ctx));
    }

    if (req.method === "POST" && pathname === "/pool/export-accounts") {
      const result = syncExtraFromOverrides(ctx.cfg.accountsExtraPath, store.loadAccountStates());
      return json(res, 200, { ...result, file: ctx.cfg.accountsExtraPath });
    }

    // --- web OAuth login (loopback + RFC 8628 device flow, mirrors `grok login`) ---

    if (req.method === "POST" && pathname === "/pool/login/start") {
      const input = await readJson(req);
      try {
        const started = input.mode === "device"
          ? await loginManager.startDevice()
          : await loginManager.start();
        return json(res, 200, started);
      } catch (error) {
        return json(res, 502, { error: { message: `login start failed: ${error.message}` } });
      }
    }

    const loginCode = pathname.match(/^\/pool\/login\/code\/([A-Za-z0-9-]+)$/);
    if (req.method === "POST" && loginCode) {
      const input = await readJson(req);
      try {
        const entry = await loginManager.submitCode(loginCode[1], String(input.code ?? ""));
        return json(res, 200, { ok: true, email: entry.email });
      } catch (error) {
        return json(res, 400, { error: { message: error.message } });
      }
    }

    const loginStatus = pathname.match(/^\/pool\/login\/status\/([A-Za-z0-9-]+)$/);
    if (req.method === "GET" && loginStatus) {
      const status = loginManager.status(loginStatus[1]);
      if (!status) return json(res, 404, { error: { message: "unknown login id" } });
      return json(res, 200, status);
    }

    const loginCancel = pathname.match(/^\/pool\/login\/cancel\/([A-Za-z0-9-]+)$/);
    if (req.method === "POST" && loginCancel) {
      return json(res, loginManager.cancel(loginCancel[1]) ? 200 : 404, { ok: true });
    }

    return json(res, 404, { error: { message: `unknown admin route ${pathname}` } });
  };
}
