const $ = s => document.querySelector(s);

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function fmtMs(ms) {
  if (ms == null) return "-";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString();
}

let lastTraceLevel = null;

async function refreshPremium() {
  try {
    const data = await getJson("/pool/premium");
    $("#premium").innerHTML = data.accounts.map(a => `
      <tr>
        <td>${a.label ?? "-"}</td>
        <td title="${a.email}">${a.email}</td>
        <td><span class="badge b-${a.status}">${a.status}</span></td>
        <td>${a.has_summaries ? '<span class="s2">THINKING ✓</span>' : '<span style="color:var(--dim)">no</span>'}</td>
        <td>${a.token_expires_at ? a.token_expires_at.slice(0, 16).replace("T", " ") : "-"}</td>
        <td>${a.has_refresh_token ? "yes" : "no"}</td>
        <td>
          <button onclick="checkPremium('${a.email}')">check</button>
          <button onclick="removePremium('${a.email}')">remove</button>
        </td>
      </tr>`).join("") || '<tr><td colspan="7" style="color:var(--dim)">no premium accounts — paste auth.json above</td></tr>';
  } catch (error) {
    $("#premium-note").textContent = error.message;
  }
}

window.checkPremium = async function (email) {
  $("#premium-note").textContent = `probing ${email}…`;
  try {
    const res = await fetch(`/pool/premium/check/${encodeURIComponent(email)}`, { method: "POST" });
    const data = await res.json();
    $("#premium-note").textContent = `${data.email}: ${data.result}`;
    refreshPremium();
  } catch (error) {
    $("#premium-note").textContent = error.message;
  }
};

window.removePremium = async function (email) {
  if (!confirm(`remove ${email} from the premium pool?`)) return;
  await fetch(`/pool/premium/${encodeURIComponent(email)}`, { method: "DELETE" });
  refreshPremium();
};

let currentLoginId = null;

function watchLogin(id, mode) {
  currentLoginId = id;
  $("#premium-code-box").style.display = "flex";
  const poll = setInterval(async () => {
    let st;
    try { st = await (await fetch(`/pool/login/status/${id}`)).json(); }
    catch { return; }
    if (st.status === "complete") {
      clearInterval(poll);
      $("#premium-code-box").style.display = "none";
      $("#premium-note").textContent = `✓ ${st.email} logged in and added as premium`;
      refreshPremium();
    } else if (st.status === "error" || st.status === "expired" || st.status === "cancelled") {
      clearInterval(poll);
      $("#premium-code-box").style.display = "none";
      $("#premium-note").textContent = `login ${st.status}: ${st.error ?? ""}`;
    } else {
      $("#premium-note").textContent = mode === "device"
        ? `waiting for approval of code ${st.user_code ?? "?"} — the page auto-detects when done…`
        : `waiting for the browser flow (callback ${st.redirect_uri ?? ""}) — if the xAI page shows a pairing code, paste it below…`;
    }
  }, 2000);
}

$("#premium-login").addEventListener("click", async () => {
  $("#premium-note").textContent = "starting OAuth flow…";
  try {
    const res = await fetch("/pool/login/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "loopback" })
    });
    const data = await res.json();
    if (!res.ok) {
      $("#premium-note").textContent = data.error?.message ?? "login start failed";
      return;
    }
    $("#premium-note").textContent = `complete the sign-in in the opened tab (callback: ${data.redirect_uri})…`;
    window.open(data.url, "_blank");
    watchLogin(data.id, "loopback");
  } catch (error) {
    $("#premium-note").textContent = error.message;
  }
});

$("#premium-login-device").addEventListener("click", async () => {
  $("#premium-note").textContent = "requesting device code…";
  try {
    const res = await fetch("/pool/login/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "device" })
    });
    const data = await res.json();
    if (!res.ok) {
      $("#premium-note").textContent = data.error?.message ?? "device login failed";
      return;
    }
    $("#premium-note").textContent = `open the page and approve code ${data.user_code}…`;
    window.open(data.url, "_blank");
    watchLogin(data.id, "device");
  } catch (error) {
    $("#premium-note").textContent = error.message;
  }
});

$("#premium-code-submit").addEventListener("click", async () => {
  const code = $("#premium-code").value.trim();
  if (!code) { $("#premium-note").textContent = "paste the code first"; return; }
  try {
    const res = await fetch(`/pool/login/code/${encodeURIComponent(currentLoginId ?? "")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code })
    });
    const data = await res.json();
    $("#premium-note").textContent = res.ok ? `✓ ${data.email} added as premium` : (data.error?.message ?? "failed");
    if (res.ok) { $("#premium-code-box").style.display = "none"; refreshPremium(); }
  } catch (error) {
    $("#premium-note").textContent = error.message;
  }
});

$("#premium-add").addEventListener("click", async () => {
  let parsed;
  try { parsed = JSON.parse($("#premium-paste").value); }
  catch { $("#premium-note").textContent = "invalid JSON"; return; }
  const res = await fetch("/pool/premium", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auth: parsed, premium: true })
  });
  const data = await res.json();
  $("#premium-note").textContent = res.ok ? "account added ✓" : (data.error?.message ?? "failed");
  if (res.ok) { $("#premium-paste").value = ""; refreshPremium(); }
});

$("#premium-export").addEventListener("click", async () => {
  const res = await fetch("/pool/export-accounts", { method: "POST" });
  const data = await res.json();
  $("#premium-note").textContent = `exported: ${data.synced}/${data.total} synced from pool.db`;
});

async function refresh() {
  try {
    const [health, accounts, stats, requests] = await Promise.all([
      getJson("/pool/health"),
      getJson("/pool/accounts"),
      getJson("/pool/stats"),
      getJson("/pool/requests?limit=100")
    ]);

    $("#ver").textContent = `v${health.version}`;
    $("#meta").textContent =
      `upstream ${health.upstream} · strategy ${health.strategy} · uptime ${Math.round(health.uptime_s / 60)}m · sticky ${health.sticky.responses} resp / ${health.sticky.sessions} sess`;

    const by = health.accounts_by_status ?? {};
    $("#stats").innerHTML = [
      ["accounts", health.accounts_total, "blue"],
      ["active", by.ACTIVE ?? 0, "green"],
      ["thinking 24h", stats.thinking?.pct != null ? `${stats.thinking.pct}%` : "-", "purple"],
      ["cooldown", by.COOLDOWN ?? 0, "yellow"],
      ["rate limited", by.RATE_LIMITED ?? 0, "yellow"],
      ["auth failed", by.AUTH_FAILED ?? 0, "red"],
      ["dead", by.DEAD ?? 0, "red"],
      ["requests", stats.total, "blue"],
      ["success", stats.success, "green"],
      ["failed", stats.failed, "red"],
      ["in-flight", stats.in_flight, "blue"]
    ].map(([k, v, c]) => `<div class="card"><div class="k">${k}</div><div class="v ${c}">${v}</div></div>`).join("");

    $("#accounts").innerHTML = accounts.accounts.map(a => `
      <tr>
        <td>${a.label}</td>
        <td title="${a.email ?? ""}">${a.email ?? "-"}${a.has_summaries ? ' <span class="s2">✓thinking</span>' : ""}</td>
        <td><span class="badge b-${a.status}">${a.status}</span></td>
        <td>${a.in_flight}</td>
        <td>${a.request_count}</td>
        <td>${a.error_count}</td>
        <td>${a.cooldown_remaining_ms ? fmtMs(a.cooldown_remaining_ms) : "-"}</td>
        <td>${a.token_expires_at ? a.token_expires_at.slice(11, 16) : "-"}</td>
        <td title="${a.last_error ?? ""}">${a.last_error ?? ""}</td>
      </tr>`).join("");

    $("#requests").innerHTML = requests.requests.map(r => `
      <tr>
        <td>${fmtTime(r.ts)}</td>
        <td>${r.id.slice(0, 6)}</td>
        <td>${r.method}</td>
        <td title="${r.path}">${r.path?.slice(0, 42)}</td>
        <td class="cls-${r.classification}">${r.classification ?? "-"}</td>
        <td>${r.model ?? "-"}</td>
        <td>${r.account_label ?? "-"}</td>
        <td class="s${r.status ? String(r.status)[0] : "5"}">${r.status ?? "ERR"}</td>
        <td>${fmtMs(r.latency_ms)}</td>
        <td>${r.attempts ?? "-"}</td>
        <td title="${r.error ?? ""}">${r.error ?? ""}</td>
      </tr>`).join("");

    const cfg = await getJson("/pool/config");
    if (lastTraceLevel !== cfg.trace.level) {
      lastTraceLevel = cfg.trace.level;
      $("#trace-level").value = cfg.trace.level;
    }
    $("#trace-note").textContent = `body=${cfg.trace.body} headers=${cfg.trace.headers} stream=${cfg.trace.stream}`;
  } catch (error) {
    $("#meta").innerHTML = `<span class="err">${error.message}</span>`;
  }
}

$("#trace-level").addEventListener("change", async () => {
  await fetch("/pool/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trace: { level: $("#trace-level").value } })
  });
  refresh();
});
$("#trace-refresh").addEventListener("click", refresh);

refresh();
refreshPremium();
setInterval(refresh, 2000);
setInterval(refreshPremium, 5000);
