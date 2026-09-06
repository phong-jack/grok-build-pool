import { isExpired } from "../accounts/source.js";

// Account selection: sticky affinity first (previous_response_id → session id),
// then the configured strategy over ACTIVE accounts. Never round-robin blind:
// expired tokens and non-ACTIVE accounts are skipped, with a best-effort
// fallback (soonest cooldown expiry) when nothing is strictly ACTIVE.

export class AccountPool {
  constructor({ source, sticky, health, strategy = "round-robin", premiumModels = [] }) {
    this.source = source;
    this.sticky = sticky;
    this.health = health;
    this.strategy = strategy;
    this.premiumModels = premiumModels;
    this.cursor = 0;
    this.inFlight = new Map();
    // account ids proven (via probe) to stream reasoning summaries
    this.autoPremium = new Set();
    // accounts observed NOT streaming summaries — overrides a stale premium flag
    this.noSummary = new Set();
  }

  isPremium(account) {
    if (this.noSummary.has(account.id)) return false;
    return Boolean(account.premium) || this.autoPremium.has(account.id);
  }

  // Single source of truth for probe outcomes (prober + admin API both call this).
  setSummaryCapability(accountId, hasSummaries) {
    if (hasSummaries) {
      this.autoPremium.add(accountId);
      this.noSummary.delete(accountId);
    } else {
      this.autoPremium.delete(accountId);
      this.noSummary.add(accountId);
    }
  }

  accounts() {
    return this.source.all();
  }

  #usable(account) {
    return account && account.isActive && account.auth.accessToken && !isExpired(account.auth)
      && this.health.isUsable(account.id);
  }

  #bumpInFlight(accountId, delta) {
    this.inFlight.set(accountId, Math.max(0, (this.inFlight.get(accountId) ?? 0) + delta));
  }

  start(account) {
    this.#bumpInFlight(account.id, 1);
  }

  finish(account) {
    this.#bumpInFlight(account.id, -1);
  }

  #rotation(candidates) {
    if (!candidates.length) return null;
    const chosen = candidates[this.cursor % candidates.length];
    this.cursor = (this.cursor + 1) % Number.MAX_SAFE_INTEGER;
    return chosen;
  }

  #byStrategy(candidates) {
    if (!candidates.length) return null;
    if (this.strategy === "random") {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }
    if (this.strategy === "least-used") {
      return candidates.reduce((best, cur) =>
        (this.inFlight.get(cur.id) ?? 0) < (this.inFlight.get(best.id) ?? 0) ? cur : best);
    }
    // round-robin (monotonic cursor; modulo at use keeps it stable when the list reorders)
    return this.#rotation(candidates);
  }

  #resolveStickyAccount(classification, excludeIds) {
    const wanted = [];
    if (classification?.previousResponseId) wanted.push(this.sticky.resolveByResponseId(classification.previousResponseId));
    if (classification?.pathSessionId) wanted.push(this.sticky.resolveBySessionKey(classification.pathSessionId));
    if (classification?.conversationId) wanted.push(this.sticky.resolveBySessionKey(classification.conversationId));
    if (!classification?.conversationId && classification?.sessionId) {
      wanted.push(this.sticky.resolveBySessionKey(classification.sessionId));
    }
    for (const accountId of wanted) {
      if (!accountId || excludeIds.has(accountId)) continue;
      const account = this.source.byId(accountId);
      if (this.#usable(account)) return account;
    }
    return null;
  }

  // premium account currently cooling down with the shortest remaining wait
  findPremiumInCooldown(excludeIds = new Set()) {
    let best = null;
    for (const a of this.accounts()) {
      if (excludeIds.has(a.id)) continue;
      if (!this.isPremium(a)) continue;
      if (a.isActive && a.auth.accessToken && !isExpired(a.auth)) {
        const s = this.health.get(a.id);
        if (s.effectiveStatus !== "ACTIVE" && s.cooldownUntil > Date.now()) {
          const remaining = s.cooldownUntil - Date.now();
          if (!best || remaining < best.remaining) {
            best = { id: a.id, label: a.label, remaining };
          }
        }
      }
    }
    return best;
  }

  pickFor({ classification, excludeIds = new Set(), allowFallback = true }) {
    const all = this.accounts();

    // 1. Sticky affinity (state lives on the account side — must return there)
    const stickyAccount = this.#resolveStickyAccount(classification, excludeIds);
    if (stickyAccount) return { account: stickyAccount, via: "sticky" };

    const usable = all.filter(a => this.#usable(a) && !excludeIds.has(a.id));

    // 2. premium-first: premiums serve all inference while healthy
    if (this.strategy === "premium-first" && usable.length) {
      const premiumGroup = usable.filter(a => this.isPremium(a));
      if (premiumGroup.length) {
        return { account: this.#rotation(premiumGroup), via: "premium-first" };
      }
    }

    // 3. reserve strategy: non-premium accounts do the everyday work; premium
    //    accounts serve only requests whose model is in PREMIUM_MODELS —
    //    keeping premium token burn as low as possible.
    if (this.strategy === "reserve" && usable.length) {
      const wantsPremium = Boolean(
        classification?.model && this.premiumModels.includes(classification.model));
      const premiumGroup = usable.filter(a => this.isPremium(a));
      const normalGroup = usable.filter(a => !this.isPremium(a));
      const group = wantsPremium
        ? (premiumGroup.length ? premiumGroup : normalGroup)
        : (normalGroup.length ? normalGroup : premiumGroup);
      if (group.length) {
        return { account: this.#rotation(group), via: wantsPremium ? "reserve+premium" : "reserve" };
      }
    }

    // 4. Strategy over ACTIVE accounts
    const active = usable;
    if (active.length) return { account: this.#byStrategy(active), via: this.strategy };

    // 5. Best effort: nothing strictly ACTIVE — take the account whose cooldown ends first
    if (allowFallback) {
      const cooling = all.filter(a =>
        a.isActive && a.auth.accessToken && !isExpired(a.auth) && !excludeIds.has(a.id)
        && !["AUTH_FAILED", "DEAD"].includes(this.health.effectiveStatus(a.id)));
      const id = this.health.cooldownSoonest(cooling.map(a => a.id));
      if (id) return { account: cooling.find(a => a.id === id), via: "cooldown-fallback" };
    }
    return { account: null, via: "none" };
  }

  // Metadata endpoints stick to the session's account when one is known.
  pickMetadata({ classification, excludeIds = new Set() }) {
    return this.pickFor({ classification, excludeIds });
  }

  summary() {
    const all = this.accounts();
    const states = this.health.snapshot();
    return all.map(a => {
      const s = states[a.id] ?? {};
      return {
        id: a.id,
        label: a.label,
        email: a.email,
        priority: a.priority,
        isActive: a.isActive,
        status: this.health.effectiveStatus(a.id),
        cooldown_until: s.cooldownUntil ?? 0,
        cooldown_remaining_ms: Math.max(0, (s.cooldownUntil ?? 0) - Date.now()),
        in_flight: this.inFlight.get(a.id) ?? 0,
        request_count: s.requestCount ?? 0,
        error_count: s.errorCount ?? 0,
        consecutive_errors: s.consecutiveErrors ?? 0,
        has_summaries: this.isPremium(a),
        last_used: s.lastUsed ?? null,
        last_error: s.lastError ?? null,
        token_expires_at: a.auth.expiresAt,
        subscription_tier: a.auth.subscriptionTier
      };
    });
  }
}
