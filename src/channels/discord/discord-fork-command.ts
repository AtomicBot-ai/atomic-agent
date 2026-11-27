import type { AgentRuntime } from "../../runtime/runtime-contract.js";
import type { SessionState } from "../../session/session-state.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { planChannelFork } from "../channel-fork.js";
import type { DiscordApi } from "./discord-api.js";
import { scrubDiscordError } from "./discord-channel-types.js";
import type { DiscordSessionPointer } from "./discord-session-pointer.js";

/**
 * `/fork` on Discord (ATO-2456, the part ATO-2235 left out). Copies this
 * channel's session (see `channel-fork.ts`) and puts the copy where the
 * person can talk to it without losing the original:
 *
 *  - in a guild text channel, a new public thread named after the fork;
 *    the thread's own channel id is mapped to the copy in
 *    `discord-session.json`, the channel the command came from stays on
 *    the source;
 *  - in a DM, inside an existing thread, or when Discord refuses the
 *    thread (no "Create Public Threads" permission), this channel moves
 *    to the copy and the source goes to its history, one `/switch <id>`
 *    away.
 *
 * Precedent: OpenClaw v2026.11.10 conversation-fork (a Telegram topic per
 * fork); Slack `!fork` in this repo (a thread per fork).
 */

/** Discord's limit for a thread name. */
const THREAD_NAME_MAX = 100;

/** The channel the command came from, as the inbound handler resolved it. */
export interface DiscordForkRef {
  channelId: string;
  guildId: string | undefined;
  isDm: boolean;
  label: string;
}

export interface DiscordForkDeps {
  runtime: Pick<AgentRuntime, "sessionStore" | "turnController">;
  api: Partial<Pick<DiscordApi, "createThread">>;
  sessionPointer: Pick<DiscordSessionPointer, "get" | "setCurrent">;
  logger: Pick<StructuredLogger, "info" | "warn">;
  releaseApprovalSession?: (sessionId: string) => void;
}

/** A message to post once the fork is in place. */
export interface DiscordForkMessage {
  channelId: string;
  text: string;
}

export async function runDiscordFork(
  ref: DiscordForkRef,
  deps: DiscordForkDeps,
  /** The text after `/fork`: empty for the last question, else its number. */
  at = "",
): Promise<DiscordForkMessage[]> {
  const fork = planChannelFork(deps.runtime, deps.sessionPointer.get(ref.channelId).current, {
    at,
    command: "/fork",
  });
  if (!fork.ok) return [{ channelId: ref.channelId, text: fork.message }];
  const { source, title } = fork;

  const threadId = ref.isDm ? null : await openThread(ref, title, deps);
  if (threadId !== null) {
    const label = `thread ${threadId}`;
    const state = withChat(fork.state, {
      channelId: threadId,
      ...(ref.guildId === undefined ? {} : { guildId: ref.guildId }),
      parentChannelId: ref.channelId,
      label,
    });
    deps.runtime.sessionStore.save(state);
    deps.sessionPointer.setCurrent(threadId, state.id, label);
    deps.logger.info("discord: forked session into a new thread", {
      channelId: ref.channelId,
      sourceSessionId: source.id,
      sessionId: state.id,
      threadId,
    });
    return [
      {
        channelId: ref.channelId,
        text: `Forked into the new thread <#${threadId}> (session \`${state.id}\`). This channel stays on \`${source.id}\`.`,
      },
      {
        channelId: threadId,
        text: `Forked from session \`${source.id}\`. This thread continues a copy of that conversation: @mention me here to go on.`,
      },
    ];
  }

  const state = withChat(fork.state, {
    channelId: ref.channelId,
    ...(ref.guildId === undefined ? {} : { guildId: ref.guildId }),
    label: ref.label,
  });
  deps.runtime.sessionStore.save(state);
  deps.sessionPointer.setCurrent(ref.channelId, state.id, ref.label);
  // The source cannot be running (planChannelFork refuses then), so its
  // approval binding has nothing left to serve in this channel.
  deps.releaseApprovalSession?.(source.id);
  deps.logger.info("discord: forked session in place", {
    channelId: ref.channelId,
    sourceSessionId: source.id,
    sessionId: state.id,
  });
  return [
    {
      channelId: ref.channelId,
      text:
        `Forked: this channel now continues "${title}" (session \`${state.id}\`), forked from \`${source.id}\`. ` +
        `The original is unchanged; \`/switch ${source.id}\` goes back to it.`,
    },
  ];
}

/** The fork, stamped with the channel it now lives in. */
function withChat(state: SessionState, chat: Record<string, unknown>): SessionState {
  return { ...state, metadata: { ...state.metadata, discordChannel: true, discordChat: chat } };
}

/** The new thread's channel id, or null when one could not be made. */
async function openThread(
  ref: DiscordForkRef,
  title: string,
  deps: DiscordForkDeps,
): Promise<string | null> {
  if (typeof deps.api.createThread !== "function") return null;
  try {
    return await deps.api.createThread(ref.channelId, threadName(title));
  } catch (err) {
    // Usually a thread cannot hold a thread, or the bot lacks "Create
    // Public Threads" here. Forking in place still works.
    deps.logger.warn("discord: createThread failed, forking in place", {
      channelId: ref.channelId,
      error: scrubDiscordError(err),
    });
    return null;
  }
}

export function threadName(title: string): string {
  const name = title.trim().length > 0 ? title.trim() : "Fork";
  return name.length > THREAD_NAME_MAX ? `${name.slice(0, THREAD_NAME_MAX - 1)}…` : name;
}
