/* ATO-2495: the "reserved for reply" row of the context popover.

   The agent now sends the reserve its prompt budget really held back
   (`usage.replyReserve` on the context preview and on the session's stored
   context usage; the preview's `reservedForReply` when the agent sends
   `replyCap`). That figure wins, so the popover can never disagree with the
   agent again, whatever the rule becomes. Only a figure with no agent
   number behind it (the projection, the trace, an older agent) falls back
   to the port below of src/prompt/token-budget.ts effectiveReplyReserve,
   small-window rule included (ATO-296). Either way the row never shows
   more than the prompt left of the window, like the TUI panel's
   replyReserveShown. Nothing here touches the DOM. */

/* Pinned to src/prompt/token-budget.ts. Change both together; smoke t63
   compares the share with the built preview's own reservedForReply. */
const REPLY_RESERVE_MAX_WINDOW_SHARE = 0.5;
const CTX_SMALL_WINDOW_PROMPT_ROOM = 16384;
const CTX_SMALL_WINDOW_REPLY_SHARE = 0.25;
const CTX_MIN_SMALL_WINDOW_REPLY_RESERVE = 1024;

/** effectiveReplyReserve(cap, win) without a reasoning budget: the cap, at
    most half the window, and on a window under 32k no more than leaves the
    prompt 16k (but at least a quarter of the window and at least 1024). */
function ctxPortedReplyReserve(cap, win) {
  if (!(cap > 0) || !Number.isFinite(cap)) return 0;
  if (!(win > 0)) return cap;
  const half = Math.floor(win * REPLY_RESERVE_MAX_WINDOW_SHARE);
  const small = Math.max(CTX_MIN_SMALL_WINDOW_REPLY_RESERVE,
    Math.floor(win * CTX_SMALL_WINDOW_REPLY_SHARE), win - CTX_SMALL_WINDOW_PROMPT_ROOM);
  return Math.min(cap, half, small);
}

/** The agent's own reserve for the figure on screen, or null when it sent none.
    `agentReserve` is `usage.replyReserve`; a built preview from an agent that
    sends `replyCap` but not that field already held its `reservedForReply`.
    An older agent sent the raw cap as `reservedForReply` and no `replyCap`:
    that is a cap, not a reserve. */
function ctxAgentReplyReserve(ctx) {
  if (!ctx) return null;
  if (typeof ctx.agentReserve === 'number' && ctx.agentReserve >= 0) return ctx.agentReserve;
  if (ctx.source === 'built' && ctx.replyCap > 0 && typeof ctx.reserved === 'number' && ctx.reserved >= 0) return ctx.reserved;
  return null;
}

/** What the row shows: the agent's figure when there is one, else the port
    over `cap`; never more than the prompt left of the window; 0 with no window. */
function ctxReplyReserve(cap, win, tokens, agentReserve) {
  if (!(win > 0)) return 0;
  const held = typeof agentReserve === 'number' && agentReserve >= 0 ? agentReserve : ctxPortedReplyReserve(cap, win);
  return Math.max(0, Math.min(held, win - (tokens || 0)));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {REPLY_RESERVE_MAX_WINDOW_SHARE, ctxPortedReplyReserve, ctxAgentReplyReserve, ctxReplyReserve};
}
