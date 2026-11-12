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
