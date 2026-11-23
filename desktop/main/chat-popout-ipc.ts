/**
 * ATO-561, first slice: a chat in its own window (the pure half is chat-popout.ts).
 *
 *   chatPopout:open  the main window's "Open in new window" on a chat row:
 *                    focuses the chat's window when it has one, otherwise
 *                    opens one with the mini chat page (mini-chat.html)
 *   chatPopout:mine  that page, at load: the chat its window was opened for
 *
 * The page is the mini window's (ATO-1063) and uses its routes: mini:attach
 * for the agent's frames, mini:session so the main window keeps an approval
 * of this chat for it, mini:openInMain for "Open in big window" (which also
 * closes this window, so the chat is the main window's again).
 *
 * main.ts asks chatPopoutTurnRefused in agent:chat: a chat with a window of
 * its own takes turns from that window only.
 */

import { BrowserWindow, ipcMain, type WebContents } from "electron";
import { join } from "node:path";

import {
  CHAT_POPOUT_QUERY,
  ChatPopouts,
  chatPopoutOpenRefusal,
  chatPopoutOptions,
  chatPopoutSessionId,
  chatPopoutTurnRefusal,
} from "./chat-popout.js";
import { spellcheckEnabled, wireEditContextMenu } from "./edit-context-menu.js";
import { miniChatPagePath } from "./mini-chat.js";

const windows = new ChatPopouts<BrowserWindow>();

/** True for a chat's own window: not the main window, for the Dock reopen. */
export function isChatPopout(win: BrowserWindow): boolean {
  return windows.has(win);
}

/** agent:chat's check: the refusal line when the chat has its own window and `sender` is not it. */
export function chatPopoutTurnRefused(rawSessionId: unknown, sender: WebContents): string | null {
  const id = chatPopoutSessionId(rawSessionId);
  if (!id) return null;
  const owner = windows.get(id);
  return chatPopoutTurnRefusal(!!owner, !!owner && owner.webContents === sender);
}

export interface ChatPopoutWiring {
  /** The main window as it is now, or null; never created by this. */
  mainWindow: () => BrowserWindow | null;
  /** The chats with a turn running now (main's live-turn record), null for a new chat's first turn. */
  liveSessionIds: () => Iterable<string | null>;
}

export function wireChatPopoutIpc(w: ChatPopoutWiring): void {
  const isMain = (wc: WebContents) => {
    const main = w.mainWindow();
    return !!main && !main.isDestroyed() && main.webContents === wc;
  };

  ipcMain.handle("chatPopout:open", (event, raw: unknown) => {
    if (!isMain(event.sender)) return { ok: false, error: "Only the main window opens a chat in a new window." };
    const sessionId = chatPopoutSessionId(raw);
    if (!sessionId) return { ok: false, error: "This chat has no session yet." };
    const have = windows.get(sessionId);
    if (have) {
      if (have.isMinimized()) have.restore();
      have.show();
      have.focus();
      return { ok: true, focused: true };
    }
    const refusal = chatPopoutOpenRefusal(sessionId, w.liveSessionIds());
    if (refusal) return { ok: false, error: refusal };
    const parent = BrowserWindow.fromWebContents(event.sender);
    const win = new BrowserWindow(chatPopoutOptions({
      preload: join(__dirname, "..", "preload", "preload.js"),
      spellcheck: spellcheckEnabled(process.platform),
      near: parent && !parent.isDestroyed() ? parent.getBounds() : null,
    }));
    windows.set(sessionId, win);
    wireEditContextMenu(win.webContents);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.on("closed", () => windows.deleteWindow(win));
    win.once("ready-to-show", () => {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
    });
    // The query only says "a chat's own window" (the page holds its composer until it has the chat); the id comes from chatPopout:mine.
    void win.loadFile(miniChatPagePath(__dirname), { query: CHAT_POPOUT_QUERY }).catch(() => {});
    return { ok: true, focused: false };
  });

  ipcMain.handle("chatPopout:mine", (event) => {
    const sessionId = windows.sessionOf((win) => win.webContents === event.sender);
    return sessionId ? { sessionId } : null;
  });
}
