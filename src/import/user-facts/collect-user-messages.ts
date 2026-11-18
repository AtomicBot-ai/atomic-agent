import { maskSecrets } from "../../error-reporting/secret-detector.js";
import type { ClaudeAppConversation } from "../claude-app/claude-app-source.js";

/**
 * ATO-1620 (epic ATO-1060, decision ATO-1617). Take an already-read chat
 * export and keep only what the person typed, newest first, inside a
 * limit, cut into chunks a model can read in one go.
 *
 * Only the person's own messages: no assistant replies, no reasoning, no
 * attachment text. Nothing is written to disk and no message text is
 * logged; {@link CollectedUserMessages.stats} carries the only numbers a
 * caller may log.
 *
 * Every message is run through the shared secret masker before it is
 * kept, so a key pasted into an old chat never reaches the extraction
 * model (local or, with consent, cloud).
 */

/** Which export the messages came from. Drives the source label of saved facts. */
export type ChatExportSource = "claude" | "chatgpt";

export interface ExportChatMessage {
  role: "user" | "assistant";
  text: string;
  atMs: number;
}

/** One chat of an export, reduced to what this module reads. */
export interface ExportChat {
  id: string;
  messages: readonly ExportChatMessage[];
}

export interface UserMessage {
  chatId: string;
  text: string;
  atMs: number;
}

export interface UserMessageChunk {
  /** 0-based, in reading order (newest chunk first). */
  index: number;
  /** Chats the chunk's messages come from, in order of first appearance. */
  chatIds: string[];
  messages: UserMessage[];
}

export interface CollectUserMessagesOptions {
  /** Clock for the date window. Default `Date.now()`. */
  nowMs?: number;
  /** Months back from `nowMs` to read. Default 12 (ATO-1617). `0` = no date limit. */
  monthsBack?: number;
  /** Most messages kept, newest first. Default 2000 (ATO-1617). */
  maxMessages?: number;
  /** Target chunk size in characters. Default 3500. */
  chunkChars?: number;
}

export interface CollectedUserMessagesStats {
  chats: number;
  /** Chats that gave at least one kept message. */
  chatsUsed: number;
  /** User messages in the export before any filter. */
  userMessages: number;
  /** Dropped as empty or too short to say anything ("ok", "thanks"). */
  droppedTrivial: number;
  /** Dropped as older than the date window. */
  droppedOld: number;
  /** Dropped by the message limit (the oldest ones). */
  droppedOverLimit: number;
  kept: number;
  chunks: number;
}

export interface CollectedUserMessages {
  chunks: UserMessageChunk[];
  stats: CollectedUserMessagesStats;
}

export const USER_FACTS_DEFAULT_MONTHS = 12;
export const USER_FACTS_DEFAULT_MAX_MESSAGES = 2_000;
export const USER_FACTS_DEFAULT_CHUNK_CHARS = 3_500;
/** A single message is cut to this many characters before chunking. */
export const USER_FACTS_MESSAGE_CHAR_CAP = 1_500;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Short replies that never carry a fact. Compared lower-cased, punctuation stripped. */
const TRIVIAL_REPLIES: ReadonlySet<string> = new Set([
  "ok", "okay", "k", "yes", "no", "yep", "nope", "sure", "thanks", "thank you",
  "thx", "ty", "cool", "nice", "great", "continue", "go on", "next", "more",
  "ок", "окей", "да", "нет", "ага", "спасибо", "спс", "продолжай", "дальше",
  "ещё", "еще", "супер", "класс", "понятно", "хорошо",
]);

/** Fewer letters than this and a message is taken as trivial. */
const MIN_LETTERS = 6;

export function isTrivialUserMessage(text: string): boolean {
  const flat = text.trim().toLowerCase().replace(/[\s.!?,;:)(]+/gu, " ").trim();
  if (flat.length === 0) return true;
  if (TRIVIAL_REPLIES.has(flat)) return true;
  const letters = flat.match(/\p{L}/gu);
  return (letters?.length ?? 0) < MIN_LETTERS;
}

/**
 * Collect the person's messages from `chats`: drop trivial ones, keep the
 * date window, keep the newest `maxMessages`, then chunk. Chunks follow
 * the newest-first order so a run stopped half way has read the freshest
 * part of the export.
 */
export function collectUserMessages(
  chats: readonly ExportChat[],
  options: CollectUserMessagesOptions = {},
): CollectedUserMessages {
  const nowMs = options.nowMs ?? Date.now();
  const monthsBack = options.monthsBack ?? USER_FACTS_DEFAULT_MONTHS;
  const maxMessages = positiveInt(options.maxMessages, USER_FACTS_DEFAULT_MAX_MESSAGES);
  const chunkChars = positiveInt(options.chunkChars, USER_FACTS_DEFAULT_CHUNK_CHARS);
  const sinceMs = monthsBack > 0 ? nowMs - Math.round(monthsBack * 30.44 * DAY_MS) : -Infinity;

  const stats: CollectedUserMessagesStats = {
    chats: chats.length,
    chatsUsed: 0,
    userMessages: 0,
    droppedTrivial: 0,
    droppedOld: 0,
    droppedOverLimit: 0,
    kept: 0,
    chunks: 0,
  };

  const candidates: UserMessage[] = [];
  for (const chat of chats) {
    for (const m of chat.messages) {
      if (m.role !== "user") continue;
      stats.userMessages += 1;
      if (isTrivialUserMessage(m.text)) {
        stats.droppedTrivial += 1;
        continue;
      }
      // A message with no date (0) is kept only when there is no date window.
      if (!(m.atMs >= sinceMs)) {
        stats.droppedOld += 1;
        continue;
      }
      candidates.push({ chatId: chat.id, text: m.text, atMs: m.atMs });
    }
  }

  candidates.sort((a, b) => b.atMs - a.atMs);
  const kept = candidates.slice(0, maxMessages);
  stats.droppedOverLimit = candidates.length - kept.length;
  stats.kept = kept.length;
  stats.chatsUsed = new Set(kept.map((m) => m.chatId)).size;

  const chunks = chunkMessages(
    kept.map((m) => ({ ...m, text: cleanText(m.text) })),
    chunkChars,
  );
  stats.chunks = chunks.length;
  return { chunks, stats };
}

/** Pack messages into chunks of about `chunkChars`, keeping their order. */
function chunkMessages(messages: readonly UserMessage[], chunkChars: number): UserMessageChunk[] {
  const out: UserMessageChunk[] = [];
  let current: UserMessage[] = [];
  let size = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    const chatIds: string[] = [];
    for (const m of current) if (!chatIds.includes(m.chatId)) chatIds.push(m.chatId);
    out.push({ index: out.length, chatIds, messages: current });
    current = [];
    size = 0;
  };
  for (const m of messages) {
    if (current.length > 0 && size + m.text.length > chunkChars) flush();
    current.push(m);
    size += m.text.length;
  }
  flush();
  return out;
}

function cleanText(text: string): string {
  const masked = maskSecrets(text.trim());
  return masked.length > USER_FACTS_MESSAGE_CHAR_CAP
    ? `${masked.slice(0, USER_FACTS_MESSAGE_CHAR_CAP)}…`
    : masked;
}

function positiveInt(v: number | undefined, fallback: number): number {
  return v !== undefined && Number.isInteger(v) && v > 0 ? v : fallback;
}

/** Claude app export (`ClaudeAppSource.load()`) → chats this module reads. */
export function chatsFromClaudeApp(conversations: readonly ClaudeAppConversation[]): ExportChat[] {
  return conversations.map((c) => ({
    id: c.uuid,
    // `text` only: reasoning and attachment names are not the person's words.
    messages: c.messages.map((m) => ({ role: m.role, text: m.text, atMs: m.atMs })),
  }));
}
