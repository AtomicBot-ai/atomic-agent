/**
 * Persisted map from Discord channels to agent sessions, stored at
 * `<stateDir>/discord-session.json`. Every DM channel, guild channel,
 * and thread the owner addresses the bot from is its own conversation;
 * see `ChatSessionMap` for the file format and the v1 migration.
 *
 * Kept separate from `TelegramSessionPointer` so the two channels never
 * share a session: a turn started in Discord and a turn started in
 * Telegram are different conversations.
 */

import {
  ChatSessionMap,
  type ChatSessionEntry,
  type ChatSessionMapData,
} from "../chat-session-map.js";

export class DiscordSessionPointer extends ChatSessionMap {}

export type DiscordSessionPointerData = ChatSessionMapData;
export type DiscordChatSessionEntry = ChatSessionEntry;
