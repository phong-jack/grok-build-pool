// Local admin API under /pool/* — never forwarded upstream.

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

export function createAdminHandler({ ctx }) {
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

    return json(res, 404, { error: { message: `unknown admin route ${pathname}` } });
  };
}
