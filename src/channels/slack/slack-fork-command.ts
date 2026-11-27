import type { SessionState } from "../../session/session-state.js";
import { planChannelFork } from "../channel-fork.js";
import type { SlackInboundContext, SlackRef } from "./slack-inbound-handler.js";
import { scrubSlackError, type SlackTarget } from "./slack-types.js";

/**
 * `!fork` / `/atomic fork` on Slack (ATO-2235). Copies this
 * conversation's session (see `channel-fork.ts`). In a channel the copy
 * gets a new thread: the bot posts a top-level message and that
 * message's thread is mapped to the copy, the same `channel:thread_ts`
 * key every Slack thread already uses. In a DM (one conversation per
 * DM) or when the post fails, this conversation moves to the copy and
 * the source stays in its history. The source session is not changed.
 *
 * Precedent: OpenClaw v2026.11.10 conversation-fork.
 */
export async function runSlackFork(ref: SlackRef, ctx: SlackInboundContext): Promise<string> {
  const fork = planChannelFork(ctx.runtime, ctx.sessions.get(ref.key).current);
  if (!fork.ok) return fork.message;
  const { source, title } = fork;

  const threadTs = ref.isDm ? null : await openThread(ref.target.channel, source.id, ctx);
  if (threadTs !== null) {
    const target: SlackTarget = { channel: ref.target.channel, threadTs };
    const state = withChat(fork.state, target, ref.label);
    ctx.runtime.sessionStore.save(state);
    ctx.sessions.setCurrent(`${target.channel}:${threadTs}`, state.id, ref.label);
    return `Forked into a new thread in this channel (session \`${state.id}\`). This conversation stays on \`${source.id}\`.`;
  }

  const state = withChat(fork.state, ref.target, ref.label);
  ctx.runtime.sessionStore.save(state);
  ctx.sessions.setCurrent(ref.key, state.id, ref.label);
  // The source is not running (planChannelFork refuses then).
  ctx.releaseApprovalSession?.(source.id);
  return `Forked: this conversation now continues "${title}" (session \`${state.id}\`), forked from \`${source.id}\`. The original is unchanged.`;
}

/** The new thread's root `ts`, or null when it could not be posted. */
async function openThread(
  channel: string,
  sourceId: string,
  ctx: SlackInboundContext,
): Promise<string | null> {
  if (typeof ctx.api.postMessage !== "function") return null;
  try {
    return await ctx.api.postMessage(
      { channel },
      `Forked from session \`${sourceId}\`. This thread continues a copy of that conversation: @mention me here to go on.`,
    );
  } catch (err) {
    ctx.logger.warn("slack: fork thread post failed, forking in place", { error: scrubSlackError(err) });
    return null;
  }
}

function withChat(state: SessionState, target: SlackTarget, label: string): SessionState {
  return {
    ...state,
    metadata: {
      ...state.metadata,
      slackChannel: true,
      slackChat: { channel: target.channel, ...(target.threadTs ? { threadTs: target.threadTs } : {}), label },
    },
  };
}
