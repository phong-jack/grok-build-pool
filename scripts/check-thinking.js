// Scan every pool account and report which ones get reasoning summaries
// (i.e. which accounts will show Thinking in the TUI).
//
//   node scripts/check-thinking.js
//
// Exit code 0 if at least one account has summaries, 1 otherwise.

import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { AccountSource } from "../src/accounts/source.js";
import https from "node:https";

const cfg = loadConfig();
const source = new AccountSource({ dbPath: cfg.routerDbPath, ttlMs: 0, extraPath: cfg.accountsExtraPath });

function probe(account) {
  return new Promise(resolve => {
    const body = JSON.stringify({
      model: "grok-4.6",
      input: "What is 9*9? Think briefly.",
      stream: true,
      reasoning: { summary: "concise" },
      include: ["reasoning.encrypted_content"],
      store: false,
      max_output_tokens: 500,
      temperature: 1
    });
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
    const req = https.request(
      { hostname: new URL(cfg.upstreamOrigin).hostname, path: "/v1/responses", method: "POST", headers },
      res => {
        let raw = "";
        res.on("data", c => {
          raw += c.toString("latin1");
          if (raw.includes("reasoning_summary_text.delta")) { req.destroy(); finish("THINKING"); }
        });
        res.on("end", () => {
          const m = raw.match(/"status":"(completed|incomplete|failed)"/);
          if (raw.includes("subscription:free-usage-exhausted")) finish("EXHAUSTED");
          else finish(`${res.statusCode} ${m ? m[1] : ""}`);
        });
      }
    );
    req.on("error", () => finish("conn-error"));
    req.setTimeout(60_000, () => { req.destroy(); finish("timeout"); });
    req.write(body);
    req.end();
  });
}

console.log(`scanning ${source.all().length} accounts...\n`);
let withThinking = 0;
for (const account of source.all()) {
  const result = await probe(account);
  if (result === "THINKING") withThinking++;
  console.log(
    `${account.label.padEnd(4)} ${String(account.email ?? "").slice(0, 30).padEnd(31)} ${(account.premium ? "[premium] " : "")}${result}`
  );
  await new Promise(r => setTimeout(r, 700)); // pacing
}

console.log(`\n${withThinking}/${source.all().length} account(s) stream reasoning summaries.`);
console.log(withThinking
  ? "Mark those as \"premium\": true in data/accounts.extra.json (premium-first strategy keeps Thinking alive)."
  : "No account streams summaries — add a freshly-logged-in account (npm run login) and re-run.");
source.close();
process.exit(withThinking ? 0 : 1);
