import type { SlackInboundContext, SlackRef } from "./slack-inbound-handler.js";

/**
 * `!switch <session-id>` / `/atomic switch <session-id>` on Slack
 * (ATO-2456): point this conversation at another Slack session. The way
 * back after `!fork` in a DM, which moves the DM to the copy and keeps
 * the original in its history; the same guard rails as Discord's and
 * Telegram's `/switch`.
 *
 * Precedent: Telegram and Discord `/switch` in this repo; OpenClaw
 * v2026.11.10 `/switch` after a fork in place.
 */
export function runSlackSwitch(sessionId: string, ref: SlackRef, ctx: SlackInboundContext): string {
  const id = sessionId.trim().split(/\s+/)[0] ?? "";
  if (id.length === 0) return "Usage: `!switch <session-id>`. `!status` shows this conversation's session.";
  const current = ctx.sessions.get(ref.key).current;
  if (current === id) return `This conversation is already on \`${id}\`.`;
  const session = ctx.runtime.sessionStore.load(id);
  if (!session) return `Unknown session \`${id}\`.`;
  // Slack sessions only: the TUI's and other channels' sessions live in
  // the same store, and pulling one here would re-route its approvals.
  if (session.metadata.slackChannel !== true) {
    return `Session \`${id}\` belongs to another surface (TUI or another channel); continue it there.`;
  }
  // One session, one conversation: two feeding it would interleave turns.
  const holder = ctx.sessions
    .entries?.()
    .find((e) => e.chatKey !== ref.key && e.entry.current === id);
  if (holder) {
    return `Session \`${id}\` is active in another conversation (${holder.entry.label ?? holder.chatKey}). Run \`!new\` there first.`;
  }
  if (ctx.runtime.turnController.isBusy(id)) {
    return `Session \`${id}\` has a turn in progress; try again when it finishes.`;
  }
  // A turn still running on the old session keeps its buttons until it
  // settles: `dispatchToRuntime` releases then.
  if (current && !ctx.inflight.has(ref.key)) ctx.releaseApprovalSession?.(current);
  ctx.sessions.setCurrent(ref.key, id, ref.label);
  return current
    ? `This conversation now continues session \`${id}\`. Previous session \`${current}\` archived.`
    : `This conversation now continues session \`${id}\`.`;
}
