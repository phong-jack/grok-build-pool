// Probe the main Gmail (auth.json): does grok-4.6 stream reasoning summaries?
import fs from "node:fs";

const a = JSON.parse(fs.readFileSync("C:/Users/ngoti/.grok/auth.json", "utf8"));
const entry = Object.values(a).find(v => v && v.key);
const body = JSON.stringify({
  model: "grok-4.6",
  input: "What is 6*6? Think briefly.",
  stream: true,
  reasoning: { summary: "concise" },
  include: ["reasoning.encrypted_content"],
  store: false,
  max_output_tokens: 300,
  temperature: 1
});
const res = await fetch("https://cli-chat-proxy.grok.com/v1/responses", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${entry.key}`,
    "x-xai-token-auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    "x-grok-client-version": "1.0.13",
    "x-grok-client-identifier": "grok-shell",
    "x-grok-client-mode": "interactive",
    "x-grok-model-override": "grok-4.6",
    "x-grok-user-id": entry.user_id,
    "x-email": entry.email,
    "x-grok-has-grok-code-access": "true",
    "user-agent": "grok-shell/1.0.13 (windows; x86_64)"
  },
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
console.log(`${entry.email}: ${res.status} | THINKING: ${think}`);
