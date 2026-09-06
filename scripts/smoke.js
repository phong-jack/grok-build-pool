// Smoke check against a RUNNING pool (default http://127.0.0.1:20129).
// Usage: node scripts/smoke.js [base] [--upstream]
//   --upstream  also forwards one real GET /v1/models to cli-chat-proxy.grok.com

const base = (process.argv[2] ?? process.env.POOL_BASE ?? "http://127.0.0.1:20129").replace(/\/+$/, "");
const doUpstream = process.argv.includes("--upstream");

async function get(pathname, headers = {}) {
  const res = await fetch(base + pathname, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: json ? null : text.slice(0, 400) };
}

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

const health = await get("/pool/health");
check("pool health", health.status === 200,
  health.json ? `accounts=${health.json.accounts_total} byStatus=${JSON.stringify(health.json.accounts_by_status)}` : health.text);

const accounts = await get("/pool/accounts");
check("accounts listing", accounts.status === 200 && Array.isArray(accounts.json?.accounts),
  `${accounts.json?.accounts?.length ?? 0} accounts, first=${accounts.json?.accounts?.[0]?.email ?? "-"}`);

const stats = await get("/pool/stats");
check("stats", stats.status === 200, `total=${stats.json?.total ?? "?"}`);

const dash = await fetch(base + "/dashboard");
check("dashboard", dash.ok, `status=${dash.status}`);

if (doUpstream) {
  const models = await get("/v1/models");
  check("upstream GET /v1/models via pool", models.status === 200,
    models.json ? `${models.json.data?.length ?? "?"} models` : `status ${models.status}: ${models.text}`);
} else {
  console.log("· upstream check skipped (pass --upstream to include one real GET /v1/models)");
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
