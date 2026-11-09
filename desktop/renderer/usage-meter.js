/* ---------------- session cost and plan limit (ATO-569) ----------------
   Loaded before renderer.js; declares only.

   The agent counts what a chat has spent and the account's rate limits
   (src/session/usage-meter.ts). Two ways in, one shape out:
     - GET /api/sessions/{id} carries `sessionUsage` (camelCase), stamped
       at the end of every turn: read by refreshContext with contextUsage.
     - the chat stream carries a `usage_updated` frame (snake_case) after
       every completion: live while the turn runs.
   An older agent sends neither, and the chip is simply not drawn.

   Honesty rules, the same as the terminal's: a cloud call with no known
   price is never $0 (the chip says "cost n/a", or "$0.31+" when some calls
   were priced); local models say "local"; Claude / ChatGPT subscriptions
   say "plan". A limit reading past its reset time is dropped. No em dash
   in any text here: the window's words follow the site's style. */

const USAGE_STALE_MS = 60 * 60 * 1000;
const USAGE_API_SHOWN_FROM = 80;

function usageNum(v) { return typeof v === 'number' && Number.isFinite(v) ? v : undefined; }

/** One limit reading from either source, or null when it says nothing. */
function usageLimit(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = {
    providerId: String(raw.providerId || raw.provider_id || ''),
    scope: (raw.scope === 'api' ? 'api' : 'subscription'),
    name: String(raw.name || ''),
    usedPercent: usageNum(raw.usedPercent !== undefined ? raw.usedPercent : raw.used_percent),
    remaining: usageNum(raw.remaining),
    limit: usageNum(raw.limit),
    resetsAt: usageNum(raw.resetsAt !== undefined ? raw.resetsAt : raw.resets_at),
    status: typeof raw.status === 'string' ? raw.status : undefined,
    observedAt: usageNum(raw.observedAt !== undefined ? raw.observedAt : raw.observed_at),
  };
  if (r.usedPercent === undefined && r.remaining === undefined && !r.status) return null;
  return r;
}

/** `sessionUsage` off the session row, or the `usage_updated` frame's payload. Null for neither. */
function usageFromAgent(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  const pick = (camel, snake) => usageNum(raw[camel] !== undefined ? raw[camel] : raw[snake]) || 0;
  const u = {
    costUsd: pick('costUsd', 'cost_usd'),
    pricedCalls: pick('pricedCalls', 'priced_calls'),
    unpricedCalls: pick('unpricedCalls', 'unpriced_calls'),
    localCalls: pick('localCalls', 'local_calls'),
    planCalls: pick('planCalls', 'plan_calls'),
    limits: (Array.isArray(raw.limits) ? raw.limits : []).map(usageLimit).filter(Boolean),
  };
  // A frame carries no observedAt: it was observed now.
  for (const r of u.limits) if (r.observedAt === undefined) r.observedAt = now;
  return u;
}

function usageActiveLimits(u, now) {
  return ((u && u.limits) || []).filter((r) =>
    r.resetsAt !== undefined ? r.resetsAt > now : now - (r.observedAt || 0) < USAGE_STALE_MS);
}

/** The cost word: "$0.31", "$0.31+", "cost n/a", "plan", "local", or '' before any call. */
function usageCostText(u) {
  if (!u) return '';
  if (u.pricedCalls > 0) return usageUsd(u.costUsd) + (u.unpricedCalls > 0 ? '+' : '');
  if (u.unpricedCalls > 0) return 'cost n/a';
  if (u.planCalls > 0) return 'plan';
  if (u.localCalls > 0) return 'local';
  return '';
}

function usageUsd(usd) {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '$' + usd.toFixed(3);
  if (usd < 100) return '$' + usd.toFixed(2);
  return '$' + Math.round(usd);
}

/** The plan window closest to its end, else an API budget past 80%; null when nothing qualifies. */
function usageHeadline(u, now) {
  const live = usageActiveLimits(u, now);
  const rank = (r) => (r.status === 'rejected' ? 101 : r.usedPercent !== undefined ? r.usedPercent : r.status === 'allowed_warning' ? 90 : -1);
  const best = (list) => list.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  const subs = live.filter((r) => r.scope === 'subscription' && rank(r) >= 0);
  if (subs.length) return best(subs);
  const apis = live.filter((r) => r.scope === 'api' && (r.status === 'rejected' || (r.usedPercent || 0) >= USAGE_API_SHOWN_FROM));
  return apis.length ? best(apis) : null;
}

/** "15:00" today, "Sat 09:00" this week, "20 Nov" beyond. Local time. */
function usageResetTime(at, now) {
  const d = new Date(at);
  const hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === new Date(now).toDateString()) return hhmm;
  if (at - now < 6 * 24 * 60 * 60 * 1000) return d.toLocaleDateString('en-US', {weekday: 'short'}) + ' ' + hhmm;
  return d.toLocaleDateString('en-GB', {day: 'numeric', month: 'short'});
}

/** "17% left", "limit reached", "near limit"; with `withReset`, the reset time after a comma. */
function usageLimitText(r, now, withReset) {
  const reset = withReset && r.resetsAt !== undefined ? ', resets ' + usageResetTime(r.resetsAt, now) : '';
  if (r.status === 'rejected' || (r.usedPercent !== undefined && r.usedPercent >= 100)) return 'limit reached' + reset;
  if (r.usedPercent !== undefined) return Math.max(0, Math.round(100 - r.usedPercent)) + '% left' + reset;
  if (r.remaining !== undefined) return r.remaining + ' left' + reset;
  if (r.status === 'allowed_warning') return 'near limit' + reset;
  return (r.status || 'limit') + reset;
}

/** What the chip prints: "$0.31 · 17% left". '' draws no chip. */
function usageChipText(u, now) {
  const parts = [];
  const cost = usageCostText(u);
  if (cost) parts.push(cost);
  const head = u ? usageHeadline(u, now) : null;
  if (head) parts.push(usageLimitText(head, now, false));
  return parts.join(' · ');
}

/** Amber once the headline plan window is 90% used or refused. Spend alone never warns. */
function usageUrgent(u, now) {
  const head = u ? usageHeadline(u, now) : null;
  return Boolean(head && (head.status === 'rejected' || (head.usedPercent || 0) >= 90));
}

/** The chip's tooltip, one fact per line. */
function usageTooltip(u, now) {
  if (!u) return '';
  const lines = [];
  if (u.pricedCalls > 0) lines.push('This chat so far: ' + usageUsd(u.costUsd) + ' over ' + u.pricedCalls + (u.pricedCalls === 1 ? ' priced call' : ' priced calls'));
  if (u.unpricedCalls > 0) lines.push(u.unpricedCalls + (u.unpricedCalls === 1 ? ' call' : ' calls') + ' with no known price, not counted');
  if (u.planCalls > 0) lines.push(u.planCalls + (u.planCalls === 1 ? ' call' : ' calls') + ' through a subscription, billed by the plan');
  if (u.localCalls > 0) lines.push(u.localCalls + (u.localCalls === 1 ? ' call' : ' calls') + ' on a local model, not billed');
  const live = usageActiveLimits(u, now);
  for (const r of live) {
    lines.push((r.scope === 'subscription' ? 'Plan ' : 'API ') + r.name + ': ' + usageLimitText(r, now, true));
  }
  if (!live.length && (u.planCalls > 0)) lines.push('The subscription has not reported its limit yet');
  return lines.join('\n');
}

if (typeof module !== 'undefined') {
  module.exports = {usageFromAgent, usageActiveLimits, usageCostText, usageUsd, usageHeadline, usageResetTime,
    usageLimitText, usageChipText, usageUrgent, usageTooltip};
}
