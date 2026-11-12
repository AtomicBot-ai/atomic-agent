/**
 * ATO-1063: the mini chat page's routes (renderer/mini-chat.js; the pure
 * half is mini-chat.ts).
 *
 *   mini:attach      the page is up: from now on it gets the agent's chat
 *                    and approval frames, on the same channels the main
 *                    window gets them (agent:chat, agent:approval)
 *   mini:openInMain  "Open in big window": the main window comes up (created
 *                    again when it was closed) and opens that chat; the mini
 *                    window closes
 *   mini:take        the main window's page: the chat waiting to be opened,
 *                    once (asked at load and on mini:openSession)
 *
 * The page sends with the existing agent:chat route, without a session id
 * for its first message, so it is a new chat in the agent like any other,
 * and main's live-turn record (agent:liveTurns) has it. That record is what
 * lets the main window take the turn over while it is still running.
 *
 * Approvals are not answered in the mini page: it says one is waiting and
 * offers the big window, where the card is (the main window got the request
 * too, and is asked to replay the pending ones when it opens the chat).
 */

import { app, BrowserWindow, ipcMain, type WebContents } from "electron";

import type { AgentClient } from "./agent-client.js";
import { MiniChatHandoff, MiniChatViewers, miniChatSessionId } from "./mini-chat.js";

export interface MiniChatWiring {
  /** The main window as it is now, or null; never created by this. */
  mainWindow: () => BrowserWindow | null;
  /** Shows and focuses the main window, creating it again when it was closed. */
  showMainWindow: () => BrowserWindow | null;
}

export function wireMiniChatIpc(client: AgentClient, w: MiniChatWiring): void {
  const viewers = new MiniChatViewers<WebContents>();
  const handoff = new MiniChatHandoff();

  client.on("chat", (ev: unknown) => viewers.forward("agent:chat", ev));
  client.on("approval", (ev: unknown) => viewers.forward("agent:approval", ev));

  const isMain = (wc: WebContents) => {
    const main = w.mainWindow();
    return !!main && !main.isDestroyed() && main.webContents === wc;
  };

  ipcMain.handle("mini:attach", (event) => {
    const wc = event.sender;
    // The main window has its frames already; a second copy would draw twice.
    if (isMain(wc)) return { ok: false };
    viewers.add(wc);
    wc.once("destroyed", () => viewers.delete(wc));
    return { ok: true };
  });

  ipcMain.handle("mini:openInMain", (event, raw: unknown) => {
    const sessionId = miniChatSessionId(raw);
    if (!sessionId) return { ok: false, error: "This chat has no session yet." };
    handoff.put(sessionId);
    const main = w.showMainWindow();
    if (!main || main.isDestroyed()) return { ok: false, error: "The main window could not be opened." };
    // macOS: the mini window can be a panel that never made the app active.
    if (process.platform === "darwin") app.focus({ steal: true });
    // A page still loading asks by itself once it is up (mini:take at load).
    if (!main.webContents.isLoading()) main.webContents.send("mini:openSession");
    const mini = BrowserWindow.fromWebContents(event.sender);
    if (mini && mini !== main && !mini.isDestroyed()) mini.close();
    return { ok: true };
  });

  ipcMain.handle("mini:take", (event) => {
    if (!isMain(event.sender)) return null;
    const sessionId = handoff.take();
    return sessionId ? { sessionId } : null;
  });
}
