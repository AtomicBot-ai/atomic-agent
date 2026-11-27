/**
 * ATO-2383: the "My apps" routes, and the window an app runs in.
 *
 *   apps:save     {name, html, chatId?} → {ok, app} | {ok:false, reason}
 *   apps:list     → {ok, apps}
 *   apps:rename   (id, name) → {ok, app} | {ok:false, reason}
 *   apps:delete   (id) → {ok} | {ok:false, reason}; the folder goes to the Trash
 *   apps:open     (id) → {ok} | {ok:false, reason}; its own window, or the open one focused
 *
 * Only the main window may call them. The pure part (ids, manifest, paths,
 * the scheme's answer) is my-apps-store.ts; the scheme itself is made
 * privileged with the artifact one (artifact-frame-ipc.ts), before ready.
 *
 * An app's window: no preload, no Node, sandboxed, context-isolated, in a
 * persistent session partition of its own (`persist:atomic-app-<id>`), so
 * its localStorage outlives a restart and is shared with nothing. That
 * session serves only `atomic-app://<id>/`, under the artifact CSP (no
 * network), refuses every other request, every permission and every
 * download; the window opens no other window and navigates nowhere.
 * Precedent: Goose apps (sandboxed window), Claude Desktop installed artifacts.
 */

import { BrowserWindow, ipcMain, session, shell, type Session, type WebContents } from "electron";

import { DESKTOP_STATE_DIR } from "./state-dir.js";
import {
  MY_APP_SCHEME,
  appDir,
  appPartition,
  appRequestAllowed,
  appResponse,
  appUrl,
  appsRoot,
  deleteAppFiles,
  isAppId,
  listApps,
  readApp,
  renameApp,
  saveApp,
} from "./my-apps-store.js";

export interface MyAppsIpcDeps {
  mainWindow: () => BrowserWindow | null;
  /** Defaults to `<stateDir>/apps`; the suite points it elsewhere. */
  root?: string;
}

const windows = new Map<string, BrowserWindow>();
const wiredSessions = new Set<string>();

function appSession(root: string, id: string): Session {
  const ses = session.fromPartition(appPartition(id));
  if (wiredSessions.has(id)) return ses;
  wiredSessions.add(id);
  if (!ses.protocol.isProtocolHandled(MY_APP_SCHEME)) {
    ses.protocol.handle(MY_APP_SCHEME, (req) => {
      const r = appResponse(root, req.url, id);
      return new Response(r.body, { status: r.status, headers: r.headers });
    });
  }
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !appRequestAllowed(details.url, id) }));
  ses.on("will-download", (event) => event.preventDefault());
  return ses;
}

function lockDown(wc: WebContents): void {
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (event) => event.preventDefault());
  wc.on("will-redirect", (event) => event.preventDefault());
  wc.on("will-attach-webview", (event) => event.preventDefault());
}

function openApp(root: string, id: unknown): { ok: true; focused: boolean } | { ok: false; reason: string } {
  if (!isAppId(id)) return { ok: false, reason: "bad-id" };
  const have = windows.get(id);
  if (have && !have.isDestroyed()) {
    if (have.isMinimized()) have.restore();
    have.show();
    have.focus();
    return { ok: true, focused: true };
  }
  const got = readApp(root, id);
  if (!got) return { ok: false, reason: "not-found" };
  appSession(root, id);
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 320,
    minHeight: 240,
    show: false,
    title: got.app.name,
    autoHideMenuBar: true,
    webPreferences: {
      partition: appPartition(id),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      spellcheck: false,
    },
  });
  windows.set(id, win);
  lockDown(win.webContents);
  // The window keeps the name the person gave the app, whatever the page's <title> says.
  win.on("page-title-updated", (event) => event.preventDefault());
  win.on("closed", () => { if (windows.get(id) === win) windows.delete(id); });
  win.once("ready-to-show", () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
  void win.loadURL(appUrl(id)).catch(() => {});
  return { ok: true, focused: false };
}

let wired = false;
export function wireMyAppsIpc(deps: MyAppsIpcDeps): void {
  if (wired) return;
  wired = true;
  const root = deps.root ?? appsRoot(DESKTOP_STATE_DIR);
  const fromMain = (wc: WebContents) => {
    const main = deps.mainWindow();
    return !!main && !main.isDestroyed() && main.webContents === wc;
  };
  const refused = { ok: false as const, reason: "not-main-window" };

  ipcMain.handle("apps:save", (event, input: unknown) => {
    if (!fromMain(event.sender)) return refused;
    const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    return saveApp(root, { name: o.name, html: o.html, chatId: o.chatId });
  });

  ipcMain.handle("apps:list", (event) => {
    if (!fromMain(event.sender)) return refused;
    return { ok: true, apps: listApps(root) };
  });

  ipcMain.handle("apps:rename", (event, id: unknown, name: unknown) => {
    if (!fromMain(event.sender)) return refused;
    const r = renameApp(root, id, name);
    const win = r.ok ? windows.get(r.app.id) : undefined;
    if (r.ok && win && !win.isDestroyed()) win.setTitle(r.app.name);
    return r;
  });

  ipcMain.handle("apps:delete", async (event, id: unknown) => {
    if (!fromMain(event.sender)) return refused;
    const dir = appDir(root, id);
    if (!dir || !isAppId(id)) return { ok: false, reason: "bad-id" };
    const win = windows.get(id);
    if (win && !win.isDestroyed()) win.close();
    // The Trash first, so a wrong click can be undone; the disk itself when there is none.
    const trashed = await shell.trashItem(dir).then(() => true, () => false);
    const r = trashed ? { ok: true as const } : deleteAppFiles(root, id);
    if (r.ok) {
      void session.fromPartition(appPartition(id)).clearStorageData().catch(() => {});
    }
    return r;
  });

  ipcMain.handle("apps:open", (event, id: unknown) => {
    if (!fromMain(event.sender)) return refused;
    return openApp(root, id);
  });
}
