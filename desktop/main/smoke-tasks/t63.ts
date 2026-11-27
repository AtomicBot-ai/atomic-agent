/**
 * Release-fix checks for backlog item 63 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=63`.
 *
 * 63 — "The context popover says 'reserved for reply 96k' on a 32.8k model,
 * so 'free' is always 0." `localModels.completionMaxTokens` was raised to
 * 96000 for long agent runs; the popover drew that cap verbatim as the
 * reservation, its reserve band filled the meter and "free" sat at zero. The
 * row now shows what the window can honour (ctxReplyReserve in
 * ctx-reply-reserve.js: the agent's own usage.replyReserve when it sends one,
 * else the port of effectiveReplyReserve with its small-window rule,
 * ATO-2495; the TUI panel's replyReserveShown): the cap,
 * held to half a window it does not fit in and never more than the prompt
 * left, with the full cap named in the row's tooltip. The share is pinned
 * to the agent's REPLY_RESERVE_MAX_WINDOW_SHARE. The last two checks hold
 * the popover to the figure the running agent's own context preview reports,
 * and the port to it where the same rule applies (replyShareVerdict63).
 *
 * Checked on contextHTML(), the popover's own renderer, with CTX and
 * LIVE_CONFIG staged and put back: a built preview from this agent
 * (reservedForReply already held, replyCap the raw cap), one from an older
 * agent (the raw cap as reservedForReply), a session's measured breakdown
 * (cap from LIVE_CONFIG), and a cap that fits (untouched, no tooltip).
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const show = (s: unknown) => JSON.stringify(s);

interface Popover {
  rows: Record<string, string>;
  tip: string | null;
  meterUsed: number | null;
  meterHeld: number | null;
}

export async function checks63(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, Popover>>(`(() => {
    const keep = { ctx: Object.assign({}, CTX), cfg: LIVE_CONFIG };
    const sections = [{label: 'prompt scaffold', tokens: 6000}, {label: 'conversation', tokens: 3000}];
    const read = () => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-9999px;top:0';
      host.innerHTML = contextHTML();
      document.body.appendChild(host);
      try {
        const rows = {};
        let tip = null;
        for (const dt of host.querySelectorAll('.kvgrid dt')) {
          const dd = dt.nextElementSibling;
          rows[dt.textContent] = dd ? dd.textContent : '';
          if (dt.textContent === 'reserved for reply') tip = dd && dd.getAttribute('title');
        }
        const used = host.querySelector('.ctxmeter i');
        const held = host.querySelector('.ctxmeter b');
        return { rows, tip,
          meterUsed: used ? parseFloat(used.style.width) : null,
          meterHeld: held ? parseFloat(held.style.width) : null };
      } finally { host.remove(); }
    };
    const stage = (over, cap) => {
      LIVE_CONFIG = Object.assign({}, keep.cfg || {}, {
        localModels: Object.assign({}, (keep.cfg && keep.cfg.localModels) || {}, {completionMaxTokens: cap}),
      });
      Object.assign(CTX, {tokens: 9000, source: 'built', stablePrefix: 6000, tail: 3000, cacheHitTokens: null,
        modelId: null, baseline: null, sections, pairsCap: 20, reserved: 0, replyCap: 0, agentReserve: null,
        window: 32768, windowLabel: 'prompt window'}, over);
      return read();
    };
    try {
      return {
        builtNew: stage({reserved: 16384, replyCap: 96000}, 96000),
        builtOld: stage({reserved: 96000, replyCap: 0}, 96000),
        measured: stage({source: 'measured', reserved: 0}, 96000),
        fits: stage({source: 'measured', window: 131072}, 4096),
        // ATO-2495: a 16k window holds back what the agent's small-window
        // rule leaves the reply: 4.1k, not half the window.
        smallPorted: stage({source: 'measured', window: 16384}, 16384),
        smallAgent: stage({source: 'measured', window: 16384, agentReserve: 4096}, 16384),
        agentWins: stage({source: 'built', reserved: 8192, replyCap: 16384, agentReserve: 5000}, 16384),
      };
    } finally {
      for (const k of Object.keys(CTX)) if (!(k in keep.ctx)) delete CTX[k];
      Object.assign(CTX, keep.ctx);
      LIVE_CONFIG = keep.cfg;
    }
  })()`);
  const capped = (p: Popover | undefined) =>
    !!p && p.rows["reserved for reply"] === "16.4k" && p.rows["free"] === "7.4k";
  check(
    "T63: a 96k reply cap on a 32.8k window shows the 16.4k the window can hold, and 'free' is the 7.4k actually left",
    capped(r["builtNew"]) && capped(r["builtOld"]) && capped(r["measured"]),
    show({ builtNew: r["builtNew"]?.rows, builtOld: r["builtOld"]?.rows, measured: r["measured"]?.rows }),
  );
  check(
    "T63: the row's tooltip names the full cap and the window that bounds it",
    r["builtNew"]?.tip === "Reply cap 96k; this 32.8k window holds back 16.4k for it (the reply can also use free space)"
      && /^Reply cap 96k;/.test(r["measured"]?.tip ?? ""),
    show({ builtNew: r["builtNew"]?.tip, measured: r["measured"]?.tip }),
  );
  const m = r["builtNew"];
  check(
    "T63: the meter's reserve band is the held 16.4k (50% of the window), not the rest of the bar",
    !!m && m.meterHeld !== null && Math.abs(m.meterHeld - 50) < 0.2
      && m.meterUsed !== null && m.meterUsed + m.meterHeld < 99.9,
    show({ used: m?.meterUsed, held: m?.meterHeld }),
  );
  const f = r["fits"];
  check(
    "T63: a cap that fits is shown as it is, with no tooltip",
    !!f && f.rows["reserved for reply"] === "4.1k" && f.rows["free"] === "118.0k" && !f.tip,
    show(f),
  );

  const sp = r["smallPorted"], sa = r["smallAgent"], aw = r["agentWins"];
  check(
    "T63 (ATO-2495): on a 16k window the row follows the agent's small-window rule (4.1k), ported or sent by the agent",
    !!sp && sp.rows["reserved for reply"] === "4.1k" && !!sa && sa.rows["reserved for reply"] === "4.1k",
    show({ smallPorted: sp?.rows, smallAgent: sa?.rows }),
  );
  check(
    "T63 (ATO-2495): the agent's own usage.replyReserve wins over any recomputation",
    !!aw && aw.rows["reserved for reply"] === "5.0k",
    show(aw?.rows),
  );

  // The renderer against the agent's own answer: the built preview reports
  // the configured cap (replyCap), the window and the reservation the budget
  // holds on it (reservedForReply, the same figure as usage.replyReserve).
  // The popover draws that figure, so it is compared on every route. The
  // port (no reasoning term, local budget only) is compared only where the
  // agent's figure comes from that same rule: the built-in local route with
  // no reasoning budget. A bounded think block raises the agent's reserve
  // (ATO-1295: 5024 on 16k, not 4096) and a cloud route holds the raw cap,
  // so there the port check reports a skip. An agent without the route (or
  // without replyCap, or with no window known) has nothing to compare.
  const a = await js<ReplyShareSample & { r?: unknown }>(`(async () => {
    if (!BR || !BR.contextPreview) return {skip: 'no bridge'};
    const r = await BR.contextPreview(null, '');
    if (!r || !r.ok || r.supported === false) return {skip: 'no preview route', r};
    if (typeof r.replyCap !== 'number' || !(r.contextWindow > 0)) return {skip: 'no replyCap or window', r: {replyCap: r.replyCap, contextWindow: r.contextWindow}};
    const usageReserve = r.usage && typeof r.usage.replyReserve === 'number' ? r.usage.replyReserve : null;
    const lm = (LIVE_CONFIG && LIVE_CONFIG.localModels) || {};
    return {replyCap: r.replyCap, contextWindow: r.contextWindow, reservedForReply: r.reservedForReply,
      share: REPLY_RESERVE_MAX_WINDOW_SHARE,
      ours: ctxPortedReplyReserve(r.replyCap, r.contextWindow),
      drawn: ctxReplyReserve(r.replyCap, r.contextWindow, 0,
        ctxAgentReplyReserve({source: 'built', replyCap: r.replyCap, reserved: r.reservedForReply, agentReserve: usageReserve})),
      usageReserve,
      reasoningBudget: typeof lm.reasoningBudgetTokens === 'number' ? lm.reasoningBudgetTokens : 0,
      providerId: selActiveProviderId() || null};
  })()`);
  const v = replyShareVerdict63(a);
  check(
    "T63 (ATO-2495): the popover draws the reservation the agent's own context preview reports, one figure on usage and reservedForReply",
    v.agent,
    show(a),
  );
  check(
    "T63: the popover's ported reply share matches the agent's reservation where the same rule applies (built-in local route, no reasoning budget)",
    v.port,
    show({ ...a, portSkip: v.portSkip ?? null }),
  );
}

/** One answer of the agent's context preview, as the smoke gathers it. */
export interface ReplyShareSample {
  skip?: string;
  replyCap?: number;
  contextWindow?: number;
  reservedForReply?: number;
  share?: number;
  ours?: number;
  drawn?: number;
  usageReserve?: number | null;
  reasoningBudget?: number;
  providerId?: string | null;
}

/**
 * The two T63 drift checks over one preview sample. `agent`: the reply
 * carries one reserve and the popover draws it. `port`: the renderer's port
 * equals the agent's figure, judged only on the built-in local route with no
 * reasoning budget; elsewhere it passes with `portSkip` naming why.
 */
export function replyShareVerdict63(a: ReplyShareSample): { agent: boolean; port: boolean; portSkip?: string } {
  if (a.skip !== undefined) return { agent: true, port: true, portSkip: a.skip };
  const reserved = a.reservedForReply;
  const win = a.contextWindow;
  const agent = typeof reserved === "number" && typeof win === "number"
    && (a.usageReserve === null || a.usageReserve === undefined || a.usageReserve === reserved)
    && a.drawn === Math.min(reserved, win);
  if ((a.reasoningBudget ?? 0) > 0) return { agent, port: true, portSkip: "reasoning budget raises the agent's reserve" };
  if (a.providerId && a.providerId !== "local-llama") return { agent, port: true, portSkip: "not the built-in local route" };
  return { agent, port: a.share === 0.5 && a.ours === reserved };
}
