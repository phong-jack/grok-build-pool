// Probe the first extra account: does each model stream reasoning summaries?
import fs from "node:fs";

const acc = JSON.parse(fs.readFileSync("data/accounts.extra.json", "utf8"))[0];

async function ask(model) {
  const body = JSON.stringify({
    model,
    input: "What is 8*8? Think briefly.",
    stream: true,
    reasoning: { summary: "concise" },
    include: ["reasoning.encrypted_content"],
    store: false,
    max_output_tokens: 500,
    temperature: 1
  });
  const headers = {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${acc.accessToken}`,
    "x-xai-token-auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    "x-grok-client-version": "1.0.13",
    "x-grok-client-identifier": "grok-shell",
    "x-grok-client-mode": "interactive",
    "x-grok-model-override": model,
    "x-grok-has-grok-code-access": "true",
    "user-agent": "grok-shell/1.0.13 (windows; x86_64)"
  };
  if (acc.userId) headers["x-grok-user-id"] = acc.userId;
  if (acc.email) headers["x-email"] = acc.email;

  const res = await fetch("https://cli-chat-proxy.grok.com/v1/responses", {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(90_000)
  });
  let think = false;
  try {
    if (res.body) {
      for await (const c of res.body) {
        if (Buffer.from(c).toString("latin1").includes("reasoning_summary_text.delta")) {
          think = true;
          break;
        }
      }
    }
  } catch {}
  try { await res.body?.cancel(); } catch {}
  return `${model} -> ${res.status} | THINKING: ${think}`;
}

console.log(await ask("grok-4.5"));
await new Promise(r => setTimeout(r, 1500));
console.log(await ask("grok-4.6"));
