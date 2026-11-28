/**
 * ATO-2755: the Electron half of approval-notify.ts.
 *
 *   approvalNotify:describe  the main window's page drew (or kept) an
 *                            approval card: its words, its chat, whether
 *                            that chat is on screen
 *   approvalNotify:pending   the page: the ids of the cards still open, on
 *                            every change and every few seconds; a shown
 *                            notification whose card went closes
 *   approvalNotify:open      main → page: a notification was clicked, take
 *                            the chat to open (sent once the page is up)
 *   approvalNotify:take      the page: the chat to open, once (asked at load
 *                            and on approvalNotify:open)
 *
 * The agent's events stream is watched too, for a request that comes while
 * there is no main window (closed to the tray or the Dock): its click opens
 * the window again, and the page takes the chat once it has loaded.
 *
 * The phone push (Settings, Phone push) gets the same words, as the
 * turn-end note does (pushTurnNote).
 */

import { ipcMain, Notification, type BrowserWindow, type WebContents } from "electron";

import { configGetKey } from "./agent-cli.js";
import type { AgentClient } from "./agent-client.js";
import { ApprovalNotifier, sessionTitleOf } from "./approval-notify.js";
import { pushTurnNote } from "./push-ipc.js";
import { readNotifyConfig } from "./turn-notify.js";

export interface ApprovalNotifyWiring {
  /** The main window as it is now, or null; never created by this. */
  mainWindow: () => BrowserWindow | null;
  /** Shows and focuses the main window, creating it again when it was closed. */
  showMainWindow: () => void;
  /** The smoke run: nobody to interrupt, nothing is raised. */
  quiet: boolean;
}

export function wireApprovalNotify(client: AgentClient, w: ApprovalNotifyWiring): ApprovalNotifier {
  /** The chat a clicked notification opens, until the page takes it. */
  let toOpen: string | null = null;
  /** Electron drops a click handler of a notification nobody holds. */
  const held = new Set<Notification>();

  const live = () => {
    const main = w.mainWindow();
    return main && !main.isDestroyed() ? main : null;
  };

  const openChat = (sessionId: string | null) => {
    toOpen = sessionId;
    w.showMainWindow();
    const main = live();
    // A page still loading (or created by the click) asks by itself at load.
    if (main && !main.webContents.isLoading()) main.webContents.send("approvalNotify:open");
  };

  const notifier = new ApprovalNotifier({
    isFocused: () => w.quiet || !!live()?.isFocused(),
    readEnabled: async () => {
      if (w.quiet) return false;
      const res = await configGetKey("tui.notify");
      return res.ok ? readNotifyConfig(res.value).enabled : true;
    },
    pageAlive: () => !!live(),
    chatTitle: async (sessionId) => sessionTitleOf(await client.session(sessionId)),
    show: (note, target) => {
      void pushTurnNote({ ...note, waiting: true });
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: note.title, body: note.body });
      held.add(n);
      const drop = () => { held.delete(n); notifier.forget(target.approvalId); };
      n.on("click", () => { drop(); openChat(target.sessionId); });
      n.on("close", drop);
      n.show();
      return () => { drop(); n.close(); };
    },
  });

  client.on("approval", (ev: unknown) => { void notifier.fromAgent(ev); });

  const isMain = (sender: WebContents) => live()?.webContents === sender;
  ipcMain.on("approvalNotify:describe", (event, raw: unknown) => {
    if (isMain(event.sender)) void notifier.fromPage(raw);
  });
  ipcMain.on("approvalNotify:pending", (event, raw: unknown) => {
    if (isMain(event.sender)) notifier.stillOpen(raw);
  });
  ipcMain.handle("approvalNotify:take", (event) => {
    if (!isMain(event.sender)) return null;
    const sessionId = toOpen;
    toOpen = null;
    return sessionId ? { sessionId } : null;
  });

  return notifier;
}
