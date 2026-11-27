/**
 * ATO-1741 / ATO-1744: the `chatgptOauth:*` routes (chatgpt-oauth-login.ts
 * does the work and says why it is built this way).
 *
 *   chatgptOauth:start  → { ok, state: "signed_in" | "failed", reason?, providerId? }
 *   chatgptOauth:cancel → { ok, state: "cancelled" | "idle" }
 *   chatgptOauth:status → { ok, signedIn, plan, supported }
 *   chatgptOauth:signOut → { ok, state: "signed_out" | "failed", hadSignIn?, reason?, detail? }
 *     (ATO-2511, chatgpt-oauth-signout.ts; `detail` is shown only behind "Details")
 *
 * Nothing else crosses to the window: not the sign-in link, not the agent's
 * output, not a token. The sign-in is stopped when the window that started
 * it goes away and when the app quits.
 */

import { spawn } from "node:child_process";
import { app, ipcMain, shell } from "electron";

import { resolveBinary } from "./agent-client.js";
import { atagRun } from "./agent-cli.js";
import { createChatgptOauth, type OauthChild } from "./chatgpt-oauth-login.js";
import { chatgptSignOut } from "./chatgpt-oauth-signout.js";
import { agentEnv } from "./state-dir.js";

export function wireChatgptOauthIpc(): void {
  const oauth = createChatgptOauth({
    binary: resolveBinary,
    // An argv array, no shell; stdout is read for the link and never logged.
    spawn: (binary, args) =>
      spawn(binary, args, { env: agentEnv(), stdio: ["ignore", "pipe", "ignore"], windowsHide: true }) as unknown as OauthChild,
    run: (args, timeoutMs) => atagRun(args, timeoutMs).then((r) => ({ stdout: r.stdout, stderr: r.stderr })),
    openExternal: (url) => shell.openExternal(url),
    platform: process.platform,
  });

  app.on("before-quit", () => { oauth.cancel(); });

  ipcMain.handle("chatgptOauth:start", (event) => {
    // The window that asked is gone (closed, reloaded): the sign-in stops with it.
    const onGone = (): void => { oauth.cancel(); };
    event.sender.once("destroyed", onGone);
    return oauth.start().finally(() => { event.sender.off("destroyed", onGone); });
  });
  ipcMain.handle("chatgptOauth:cancel", () => ({ ok: true, state: oauth.cancel() ? "cancelled" : "idle" }));
  ipcMain.handle("chatgptOauth:status", () => oauth.status());
  // ATO-2511: a sign-in still waiting on the browser is stopped first, so it cannot write tokens back after the sign-out.
  ipcMain.handle("chatgptOauth:signOut", () => {
    oauth.cancel();
    return chatgptSignOut({ run: (args, timeoutMs) => atagRun(args, timeoutMs) });
  });
}
