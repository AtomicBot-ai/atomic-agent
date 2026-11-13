import { join } from "node:path";

/**
 * ATO-1063 (epic ATO-985, item 2): the mini window's page is a small chat of
 * its own, renderer/mini-chat.html. It starts a NEW chat, streams the reply,
 * and its "Open in big window" brings the main window up on that same chat.
 *
 * This module is the pure half (no Electron import, so the node tests load
 * it as is): where the page is, the size it is drawn for, the session id it
 * may hand over, the one hand-over waiting for the main window, and the set
 * of pages the agent's frames are forwarded to. mini-chat-ipc.ts is the
 * Electron half.
 *
 * The window itself (the global hotkey, always on top) is ATO-523's
 * (quick-entry-window.ts); it loads this page with miniChatPagePath().
 */

/** The size the page is laid out for, in DIP: room for a question and a few paragraphs of reply. */
export const MINI_CHAT_SIZE = { width: 480, height: 560 } as const;

/** The page, from the compiled main process's folder (`__dirname` in out/main). */
export function miniChatPagePath(mainDir: string): string {
  return join(mainDir, "..", "renderer", "mini-chat.html");
}

/** A session id the page may hand to the main window: a short token, nothing that could be a path or markup. */
export function miniChatSessionId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return /^[A-Za-z0-9_.:-]{1,200}$/.test(id) ? id : null;
}

/**
 * The chat the main window is to open, waiting until its page takes it.
 * A main window closed meanwhile is created again and asks once its page is
 * up; one already up is told, and asks. Taken once, so it opens once.
 */
export class MiniChatHandoff {
  private pending: string | null = null;

  put(sessionId: string): void {
    this.pending = sessionId;
  }

  take(): string | null {
    const id = this.pending;
    this.pending = null;
    return id;
  }
}

/** What a page is, as far as forwarding goes (Electron's WebContents). */
export interface MiniChatViewer {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

/**
 * The mini pages open now. main.ts sends the agent's chat and approval
 * frames to the main window only; these pages get the same frames on the
 * same channels, so the page reads them with the preload's own onChat and
 * onApproval. Each page keeps only the frames of the turn it started.
 */
export class MiniChatViewers<V extends MiniChatViewer = MiniChatViewer> {
  private readonly open = new Set<V>();

  add(viewer: V): void {
    this.open.add(viewer);
  }

  delete(viewer: V): void {
    this.open.delete(viewer);
  }

  size(): number {
    return this.open.size;
  }

  forward(channel: string, payload: unknown): void {
    for (const v of [...this.open]) {
      if (v.isDestroyed()) {
        this.open.delete(v);
        continue;
      }
      try {
        v.send(channel, payload);
      } catch {
        /* a page going away */
      }
    }
  }
}

/** How many mini chats the main window is told about, newest kept. */
export const MINI_CHAT_SESSIONS_MAX = 50;

/**
 * The chats the mini window started, sessionId → its first message (a
 * title). The main window is told each one (mini:sessionKnown) and asks for
 * the list when its page loads (mini:sessions): it never saw those turns
 * start, so without this an approval of one has no chat to be kept for and
 * is drawn in whatever chat it shows.
 */
export class MiniChatSessions {
  private readonly known = new Map<string, string>();

  /** The chat, when it is new here (the main window is to be told); null for a repeat or a bad id. */
  add(rawId: unknown, rawTitle: unknown): { sessionId: string; title: string } | null {
    const sessionId = miniChatSessionId(rawId);
    if (!sessionId) return null;
    const title = typeof rawTitle === "string" ? rawTitle.trim().replace(/\s+/g, " ").slice(0, 200) : "";
    if (this.known.has(sessionId)) return null;
    this.known.set(sessionId, title);
    while (this.known.size > MINI_CHAT_SESSIONS_MAX) this.known.delete(this.known.keys().next().value as string);
    return { sessionId, title };
  }

  list(): Array<{ sessionId: string; title: string }> {
    return [...this.known].map(([sessionId, title]) => ({ sessionId, title }));
  }
}

/** What a window is, as far as its blur listeners go (Electron's BrowserWindow). */
export interface MiniChatBlurTarget {
  removeAllListeners(event: "blur"): unknown;
  on(event: "blur", listener: (...args: unknown[]) => void): unknown;
}

/**
 * The mini chat window stays up when it loses focus: it closes only on Esc,
 * the hotkey or its close button. The window that hosts the page (ATO-523's
 * quick-entry-window.ts) puts itself away on blur, which would close the chat
 * while a reply is written, so the page's attach drops the window's blur
 * listeners. `relay` puts back Electron's own one (app "browser-window-blur").
 * Nothing else is touched: "closed" and the rest stay as they are.
 */
export function miniChatKeepOnBlur(win: MiniChatBlurTarget, relay?: (...args: unknown[]) => void): void {
  win.removeAllListeners("blur");
  if (relay) win.on("blur", relay);
}
