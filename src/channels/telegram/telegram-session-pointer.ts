import {
  ChatSessionMap,
  type ChatSessionEntry,
  type ChatSessionMapData,
} from "../chat-session-map.js";

/**
 * Persisted map from Telegram chats to agent sessions, stored at
 * `<stateDir>/telegram-session.json`. Each private chat, group, or
 * forum topic the owner talks to the bot from is its own conversation;
 * see `ChatSessionMap` for the file format and the v1 migration.
 *
 * Kept as its own class (and file) so Telegram and Discord can never
 * share a session: a turn started in Discord and a turn started in
 * Telegram are different conversations.
 */
export class TelegramSessionPointer extends ChatSessionMap {}

export type TelegramSessionPointerData = ChatSessionMapData;
export type TelegramChatSessionEntry = ChatSessionEntry;

/**
 * Chat key for a Telegram message. A forum topic is a separate
 * conversation from its supergroup's General topic, so the topic id
 * is folded in when present.
 */
export function telegramChatKey(chatId: number, threadId?: number): string {
  return threadId === undefined ? String(chatId) : `${chatId}:${threadId}`;
}
