import { miniChatSessionId } from "./mini-chat.js";

/**
 * ATO-561, first slice: "Open in new window" for a chat in the sidebar.
 *
 * The chat opens in a window of its own that loads the mini chat page
 * (renderer/mini-chat.html, ATO-1063), not a second copy of index.html: a
 * second full renderer would run its own copies of the window's global state
 * (queues, prefs writers, downloads, the live-turn takeover), each believing
 * it is the only one. The mini page is a small chat with none of that: it
 * loads the chat's transcript, sends with the main window's own route
 * (agent:chat with the chat's session id) and follows only the turns it
 * started.
 *
 * One window per chat. While a chat has its own window, only that window
 * starts turns in it: main's agent:chat refuses one from any other page
 * (chatPopoutTurnRefusal), so the two windows never write into one chat at
 * once. A chat whose reply is still being written is not popped out
 * (chatPopoutOpenRefusal): that turn's frames belong to the window that
 * started it.
 *
 * This module is the pure half (no Electron import, so the node tests load
 * it as is); chat-popout-ipc.ts is the Electron half.
 */

/** A normal chat window: smaller than the main one (1280x820), roomy enough to read a reply. */
export const CHAT_POPOUT_SIZE = { width: 760, height: 780, minWidth: 420, minHeight: 440 } as const;

/** How far a new chat window opens from the one it was opened from, so it does not hide exactly over it. */
export const CHAT_POPOUT_OFFSET = 40;

/** The page's query in a chat's own window (renderer/mini-chat.js reads it before anything else). */
export const CHAT_POPOUT_QUERY = { window: "chat" } as const;

/** A chat id the main window may pop out: the mini page's own rule (a short token, nothing that could be a path or markup). */
export function chatPopoutSessionId(raw: unknown): string | null {
  return miniChatSessionId(raw);
}

export interface ChatPopoutBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChatPopoutOptionsInput {
  /** The preload script, the main window's own (preload/preload.js). */
  preload: string;
  spellcheck: boolean;
  /** The window it was opened from: the new one opens a little below and right of it. */
  near?: ChatPopoutBounds | null;
}

/**
 * The BrowserWindow options: an ordinary window (a frame, resizable, in the
 * taskbar, not on top of other apps), with the main window's webPreferences.
 */
export function chatPopoutOptions(o: ChatPopoutOptionsInput) {
  const near = o.near && [o.near.x, o.near.y].every(Number.isFinite) ? o.near : null;
  return {
    width: CHAT_POPOUT_SIZE.width,
    height: CHAT_POPOUT_SIZE.height,
    minWidth: CHAT_POPOUT_SIZE.minWidth,
    minHeight: CHAT_POPOUT_SIZE.minHeight,
    ...(near ? { x: Math.round(near.x + CHAT_POPOUT_OFFSET), y: Math.round(near.y + CHAT_POPOUT_OFFSET) } : {}),
    show: false,
    backgroundColor: "#191C21",
    title: "Atomic Agent",
    webPreferences: {
      preload: o.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: o.spellcheck,
    },
  };
}

/** What a window is, as far as the map goes (Electron's BrowserWindow). */
export interface ChatPopoutLike {
  isDestroyed(): boolean;
}

/** The chats open in windows of their own: one window per chat, sessionId → window. */
export class ChatPopouts<W extends ChatPopoutLike = ChatPopoutLike> {
  private readonly bySession = new Map<string, W>();

  /** The chat's window, when it has one still open. */
  get(sessionId: string): W | null {
    const w = this.bySession.get(sessionId);
    if (!w) return null;
    if (w.isDestroyed()) {
      this.bySession.delete(sessionId);
      return null;
    }
    return w;
  }

  /** False when the chat already has a window (that one is to be focused instead). */
  set(sessionId: string, win: W): boolean {
    if (this.get(sessionId)) return false;
    this.bySession.set(sessionId, win);
    return true;
  }

  /** The window closed: its chat is free again. */
  deleteWindow(win: W): void {
    for (const [id, w] of this.bySession) if (w === win) this.bySession.delete(id);
  }

  /** The chat a window was opened for, or null. */
  sessionOf(match: (win: W) => boolean): string | null {
    for (const [id, w] of this.bySession) {
      if (w.isDestroyed()) continue;
      if (match(w)) return id;
    }
    return null;
  }

  has(win: W): boolean {
    for (const w of this.bySession.values()) if (w === win) return true;
    return false;
  }

  size(): number {
    for (const [id, w] of this.bySession) if (w.isDestroyed()) this.bySession.delete(id);
    return this.bySession.size;
  }
}

export const CHAT_POPOUT_LIVE_LINE = "A reply is still being written in this chat. Open it in its own window once it is done.";
export const CHAT_POPOUT_OWNED_LINE = "This chat is open in its own window. Send from there, or close that window first.";

/** Why the chat cannot get a window now (a turn of it still running), or null. */
export function chatPopoutOpenRefusal(sessionId: string, liveSessionIds: Iterable<string | null | undefined>): string | null {
  for (const sid of liveSessionIds) if (sid === sessionId) return CHAT_POPOUT_LIVE_LINE;
  return null;
}

/**
 * Whether agent:chat refuses a turn: the chat has a window of its own and
 * the page asking is not that window. A chat with no window, or a new chat
 * (no session id), is never refused here.
 */
export function chatPopoutTurnRefusal(hasWindow: boolean, fromThatWindow: boolean): string | null {
  return hasWindow && !fromThatWindow ? CHAT_POPOUT_OWNED_LINE : null;
}
