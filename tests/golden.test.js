// Golden tests: pool (child process) -> mock upstream. Verifies the v4 contract:
// byte-identical passthrough, catch-all forwarding, header identity swap,
// sticky affinity, round-robin, failover on retryable statuses, no retry on 400.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createMockUpstream } from "./mock-upstream.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "grok-pool-test-"));

const ACCOUNTS = [
  { id: "acc-1", email: "one@test.local", userId: "user-1", token: "acct-A1" },
  { id: "acc-2", email: "two@test.local", userId: "user-2", token: "acct-A2" },
  { id: "acc-3", email: "three@test.local", userId: "user-3", token: "acct-A3" }
];

function makeRouterDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE providerConnections (
    id TEXT, provider TEXT, authType TEXT, name TEXT, email TEXT,
    priority INTEGER, isActive INTEGER, data TEXT, createdAt TEXT, updatedAt TEXT)`);
  const insert = db.prepare(
    `INSERT INTO providerConnections VALUES (?, 'grok-cli', 'oauth', ?, ?, ?, 1, ?, ?, ?)`);
  for (const [i, a] of ACCOUNTS.entries()) {
    insert.run(
      a.id, a.email, a.email, i + 1,
      JSON.stringify({
        accessToken: a.token,
        refreshToken: null,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        providerSpecificData: { userId: a.userId, email: a.email, hasGrokCodeAccess: true }
      }),
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"
    );
  }
  db.close();
}

let mock, poolPort, poolProc, poolBase, traceDir;

async function waitHealthy(base, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/pool/health`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error("pool did not become healthy in time");
}

before(async () => {
  mock = createMockUpstream();
  const mockPort = await mock.start();

  const routerDb = path.join(TMP, "router-db.sqlite");
  makeRouterDb(routerDb);
  traceDir = path.join(TMP, "traces");

  const probe = await new Promise(resolve => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  poolPort = probe.address().port;
  await new Promise(r => probe.close(r));

  poolProc = spawn(process.execPath, ["src/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(poolPort),
      UPSTREAM_ORIGIN: `http://127.0.0.1:${mockPort}`,
      ROUTER_DB_PATH: routerDb,
      POOL_DB_PATH: path.join(TMP, "pool.db"),
      TRACE_DIR: traceDir,
      GROK_TRACE: "debug",
      POOL_STRATEGY: "round-robin",
      MAX_FAILOVERS: "4",
      LOGIN_ROOT: path.join(TMP, "logins")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  poolProc.stdout.on("data", () => {});
  poolProc.stderr.on("data", d => console.error("[pool]", d.toString().trim()));

  poolBase = `http://127.0.0.1:${poolPort}`;
  await waitHealthy(poolBase);
});

after(() => {
  poolProc?.kill();
  mock?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

async function postJson(pathname, body, headers = {}) {
  return fetch(poolBase + pathname, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

test("admin: health reports 3 accounts", async () => {
  const res = await fetch(`${poolBase}/pool/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.accounts_total, 3);
  assert.equal(data.accounts_by_status.ACTIVE, 3);
});

test("dashboard serves", async () => {
  const res = await fetch(`${poolBase}/dashboard`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(await res.text(), /GROK POOL/);
});

test("byte-identical SSE passthrough on /v1/responses", async () => {
  const expected =
    'event: response.created\n' +
    'data: {"type":"response.created","response":{"id":"resp_mock_0001","model":"grok-4.5"}}\n\n' +
    'event: response.output_text.delta\n' +
    'data: {"type":"response.output_text.delta","delta":"héllo wörld — ✓"}\n\n' +
    'event: response.completed\n' +
    'data: {"type":"response.completed","response":{"id":"resp_mock_0001"}}\n\n';
  const res = await postJson("/v1/responses", { model: "grok-4.5", stream: true, input: "hi" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const bytes = Buffer.from(await res.arrayBuffer()).toString("utf8");
  assert.equal(bytes, expected);
});

test("catch-all: unknown endpoint is forwarded verbatim with query", async () => {
  const res = await fetch(`${poolBase}/v1/brand-new-endpoint?x=1&y=%C3%A9`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ anything: true })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.echoed, true);
  assert.equal(data.method, "PATCH");
  assert.equal(data.url, "/v1/brand-new-endpoint?x=1&y=%C3%A9");
});

test("headers: client x-grok-* preserved, identity swapped per account", async () => {
  const res = await postJson("/v1/responses", { model: "grok-4.5" }, {
    "x-grok-session-id": "sess-abc",
    "x-grok-custom-header": "keepme",
    "user-agent": "grok-shell/9.9.9-test"
  });
  assert.equal(res.status, 200);
  const last = mock.received.at(-1);
  assert.equal(last.headers["x-grok-session-id"], "sess-abc");
  assert.equal(last.headers["x-grok-custom-header"], "keepme");
  assert.equal(last.headers["user-agent"], "grok-shell/9.9.9-test");
  assert.ok(last.token.startsWith("acct-"), "client auth replaced by account token");
  assert.match(last.headers["x-grok-user-id"], /^user-[123]$/);
  assert.match(last.headers["x-email"], /@test\.local$/);
});

test("metadata GET /v1/settings works through pool", async () => {
  const res = await fetch(`${poolBase}/v1/settings`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.object, "settings");
  assert.match(data.served_by, /^acct-/);
});

test("sticky: previous_response_id returns to the same account", async () => {
  const first = await postJson("/v1/responses", { model: "grok-4.5" });
  assert.equal(first.status, 200);
  const firstAccount = mock.received.at(-1).token;

  mock.resetReceived();
  const followUp = await postJson("/v1/responses", {
    model: "grok-4.5",
    previous_response_id: "resp_mock_0001"
  });
  assert.equal(followUp.status, 200);
  assert.equal(mock.received.at(-1).token, firstAccount, "follow-up must hit the account that produced the response id");
});

test("sticky: same session id (metadata + inference) stays on one account", async () => {
  const res1 = await fetch(`${poolBase}/v1/settings`, { headers: { "x-grok-session-id": "sess-sticky-1" } });
  assert.equal(res1.status, 200);
  const account = mock.received.at(-1).token;

  const res2 = await postJson("/v1/responses", { model: "grok-4.5" }, { "x-grok-session-id": "sess-sticky-1" });
  assert.equal(res2.status, 200);
  assert.equal(mock.received.at(-1).token, account, "session follow-up must hit the same account");
});

test("sticky: path session uuid (/v1/sessions/<uuid>/*) stays on one account", async () => {
  const sid = "01a075ea-f3f8-7513-a640-73a4df0d5779";
  const res1 = await postJson(`/v1/sessions/${sid}/signals`, { type: "start" });
  assert.equal(res1.status, 200);
  const account = mock.received.at(-1).token;

  mock.resetReceived();
  const res2 = await postJson(`/v1/sessions/${sid}/signals`, { type: "keepalive" });
  assert.equal(res2.status, 200);
  assert.equal(mock.received.at(-1).token, account, "same path-session uuid must hit the same account");
});

test("round-robin rotates accounts across independent requests", async () => {
  mock.resetReceived();
  for (let i = 0; i < 3; i++) {
    const res = await postJson("/v1/responses", { model: "grok-4.5", input: `n${i}` });
    assert.equal(res.status, 200);
  }
  const tokens = mock.received.map(r => r.token).sort();
  assert.deepEqual(tokens, ["acct-A1", "acct-A2", "acct-A3"]);
});

test("failover: 429 on the sticky account is retried on another, body replayed", async () => {
  // bind sess-fail-1 to whichever account serves the next request
  const warm = await postJson("/v1/responses", { model: "grok-4.5", input: "warm" }, { "x-grok-session-id": "sess-fail-1" });
  assert.equal(warm.status, 200);
  const stickyAccount = mock.received.at(-1).token;

  mock.setBehavior({ [stickyAccount]: { status: 429, times: 1 } });
  mock.resetReceived();
  const res = await postJson("/v1/responses", { model: "grok-4.5", input: "failover-me" }, { "x-grok-session-id": "sess-fail-1" });
  assert.equal(res.status, 200, "sticky account 429s once, follow-up account succeeds");
  const attempts = mock.received.filter(r => r.url.startsWith("/v1/responses"));
  assert.equal(attempts.length, 2, "one 429 attempt + one success");
  assert.equal(attempts[0].token, stickyAccount, "sticky routing picked the bound account first");
  assert.notEqual(attempts[1].token, stickyAccount);
  assert.equal(attempts[0].body, attempts[1].body, "same body replayed");
  mock.clearBehavior();
});

test("no retry: 400 is passed through as-is with a single attempt", async () => {
  mock.setBehavior({
    "acct-A1": { status: 400, times: 99 },
    "acct-A2": { status: 400, times: 99 },
    "acct-A3": { status: 400, times: 99 }
  });
  mock.resetReceived();
  const res = await postJson("/v1/responses", { model: "grok-4.5" });
  assert.equal(res.status, 400, "400 surfaces to the client unchanged");
  assert.equal(mock.received.length, 1, "400 must NOT trigger failover");
  mock.clearBehavior();
});

test("pool exhaustion: every account failing -> 503 with diagnostics", async () => {
  mock.setBehavior({
    "acct-A1": { status: 500, times: 99 },
    "acct-A2": { status: 500, times: 99 },
    "acct-A3": { status: 500, times: 99 }
  });
  mock.resetReceived();
  const res = await postJson("/v1/responses", { model: "grok-4.5" });
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.ok(["pool_unavailable", "all_accounts_failed"].includes(data.error.type));
  assert.equal(mock.received.length, 3, "each account tried exactly once");
  mock.clearBehavior();
});

test("traces: ndjson written with redacted auth", async () => {
  const file = path.join(traceDir, "requests.ndjson");
  assert.ok(fs.existsSync(file), "trace file exists");
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.ok(lines.length >= 5);
  const last = lines.at(-1);
  assert.ok(last.id && last.method && last.url, "records carry request identity");
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes("Bearer acct-"), "bearer tokens never appear in traces");
});
