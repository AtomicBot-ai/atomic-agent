import type { AgentRuntime } from "../../runtime/runtime-contract.js";
import type { SessionState } from "../../session/session-state.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { planChannelFork } from "../channel-fork.js";
import type { TelegramApi } from "./outbound-sender.js";
import { scrubErrorMessage } from "./telegram-channel-types.js";
import {
  telegramChatKey,
  type TelegramSessionPointer,
} from "./telegram-session-pointer.js";

/**
 * `/fork` on Telegram (ATO-2235). Copies this chat's session (see
 * `channel-fork.ts`) and puts the copy somewhere the person can talk to
 * it without losing the original:
 *
 *  - in a forum supergroup, a new topic named after the fork, mapped to
 *    the copy; the topic the command came from stays on the source;
 *  - anywhere else (a DM, a plain group, or a forum where the bot may
 *    not manage topics), this chat moves to the copy and the source
 *    goes to its history, one `/switch <id>` away.
 *
 * Precedent: OpenClaw v2026.11.10 `extensions/telegram/src/conversation-fork.ts`.
 */

/** Telegram's limit for a forum topic name. */
const TOPIC_NAME_MAX = 128;

export interface TelegramForkTarget {
  chatId: number;
  threadId?: number;
}

/** The chat the command came from, as the inbound handler resolved it. */
export interface TelegramForkRef {
  key: string;
  target: TelegramForkTarget;
  label: string;
  chatType: string;
  /** The supergroup has topics enabled (`chat.is_forum`). */
  isForum?: boolean;
}

export interface TelegramForkDeps {
  runtime: Pick<AgentRuntime, "sessionStore" | "turnController">;
  api: Pick<TelegramApi, "createForumTopic">;
  sessionPointer: Pick<TelegramSessionPointer, "get" | "setCurrent">;
  logger: Pick<StructuredLogger, "info" | "warn">;
  releaseApprovalSession?: (sessionId: string) => void;
}

/** A message to send once the fork is in place. */
export interface TelegramForkMessage {
  target: TelegramForkTarget;
  text: string;
}

export async function runTelegramFork(
  ref: TelegramForkRef,
  deps: TelegramForkDeps,
): Promise<TelegramForkMessage[]> {
  const fork = planChannelFork(deps.runtime, deps.sessionPointer.get(ref.key).current);
  if (!fork.ok) return [{ target: ref.target, text: fork.message }];
  const { source, title } = fork;

  const topic = ref.isForum === true ? await openTopic(ref, title, deps) : null;
  if (topic !== null) {
    const target = { chatId: ref.target.chatId, threadId: topic };
    const label = `${chatBaseLabel(ref.label)} › topic ${topic}`;
    const state = withChat(fork.state, { id: target.chatId, type: ref.chatType, label, threadId: topic });
    deps.runtime.sessionStore.save(state);
    deps.sessionPointer.setCurrent(telegramChatKey(target.chatId, topic), state.id, label);
    deps.logger.info("telegram: forked session into a new topic", {
      chatKey: ref.key,
      sourceSessionId: source.id,
      sessionId: state.id,
      threadId: topic,
    });
    return [
      {
        target: ref.target,
        text: `Forked into the new topic "${topicName(title)}" (session ${state.id}). This topic stays on ${source.id}.`,
      },
      {
        target,
        text: `Forked from session ${source.id}. This topic continues a copy of that conversation.`,
      },
    ];
  }

  const state = withChat(fork.state, {
    id: ref.target.chatId,
    type: ref.chatType,
    label: ref.label,
    ...(ref.target.threadId === undefined ? {} : { threadId: ref.target.threadId }),
  });
  deps.runtime.sessionStore.save(state);
  deps.sessionPointer.setCurrent(ref.key, state.id, ref.label);
  // The source cannot be running (planChannelFork refuses then), so its
  // approval binding has nothing left to serve in this chat.
  deps.releaseApprovalSession?.(source.id);
  deps.logger.info("telegram: forked session in place", {
    chatKey: ref.key,
    sourceSessionId: source.id,
    sessionId: state.id,
  });
  return [
    {
      target: ref.target,
      text:
        `Forked: this chat now continues "${title}" (session ${state.id}), forked from ${source.id}. ` +
        `The original is unchanged; /switch ${source.id} goes back to it.`,
    },
  ];
}

/** The fork, stamped with the chat it now lives in. */
function withChat(state: SessionState, chat: Record<string, unknown>): SessionState {
  return { ...state, metadata: { ...state.metadata, telegramChannel: true, telegramChat: chat } };
}

/** The new topic's thread id, or null when one could not be made. */
async function openTopic(
  ref: TelegramForkRef,
  title: string,
  deps: TelegramForkDeps,
): Promise<number | null> {
  if (typeof deps.api.createForumTopic !== "function") return null;
  try {
    const topic = await deps.api.createForumTopic(ref.target.chatId, topicName(title));
    const id = (topic as { message_thread_id?: unknown } | null)?.message_thread_id;
    if (typeof id === "number") return id;
    deps.logger.warn("telegram: createForumTopic returned no thread id", { chatKey: ref.key });
  } catch (err) {
    // Usually "not enough rights to create a topic": the bot is not an
    // admin with "Manage topics". Forking in place still works.
    deps.logger.warn("telegram: createForumTopic failed, forking in place", {
      chatKey: ref.key,
      error: scrubErrorMessage(err),
    });
  }
  return null;
}

function topicName(title: string): string {
  const name = title.trim().length > 0 ? title.trim() : "Fork";
  return name.length > TOPIC_NAME_MAX ? `${name.slice(0, TOPIC_NAME_MAX - 1)}…` : name;
}

/** "Group › topic 5" -> "Group": the new topic gets its own suffix. */
function chatBaseLabel(label: string): string {
  return label.replace(/ › topic \d+$/, "");
}
