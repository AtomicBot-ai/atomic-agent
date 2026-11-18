/**
 * ATO-586 — the window's incognito chats (renderer/incognito-chat.js).
 *
 * An incognito chat neither reads nor writes memory, can leave no tasks
 * behind, is never listed, and is deleted when it is closed (core PR #1515).
 * The agent marks a session incognito only when it CREATES it, from
 * `incognito: true` on POST /v1/chat/completions.
 *
 * The desktop restarts the agent on some actions (a model switch). The new
 * agent deletes, at boot, every incognito chat the old process owned. So the
 * desktop keeps the list of open incognito chats here, in main (which lives
 * across agent restarts), and sends the flag with EVERY turn of such a chat,
 * not only the first, as ChatGPT's Temporary Chat stays temporary for the
 * whole conversation: the next turn after a restart opens the chat again
 * under the same id, again incognito, and never as an ordinary chat that
 * would be listed and remembered.
 *
 * No Electron here, so the Node checks load it (test/incognito-chat.test.mjs).
 */

import { newChatSessionId } from "./chat-session.js";

const OPEN = new Set<string>();

/** A new incognito chat: its id, fixed before the first turn so that turn already carries the flag. */
export function openIncognitoChat(): string {
  const id = `incognito-${newChatSessionId()}`;
  OPEN.add(id);
  return id;
}

export function isIncognitoChat(id: string | null | undefined): boolean {
  return typeof id === "string" && OPEN.has(id);
}

/** Forget it; true when it was open. The agent's copy is deleted by the caller. */
export function closeIncognitoChat(id: string | null | undefined): boolean {
  return typeof id === "string" && OPEN.delete(id);
}

/** The chat request's field: `incognito: true` on every turn of an open incognito chat. */
export function incognitoBodyField(id: string | null | undefined): { incognito?: true } {
  return isIncognitoChat(id) ? { incognito: true } : {};
}

/** Every open one (the tests, and nothing else). */
export function openIncognitoChats(): string[] {
  return [...OPEN];
}
