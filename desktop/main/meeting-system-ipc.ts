/**
 * ATO-2514: the other side of a call for Record a meeting, the routes
 * (renderer/meeting-system.js; the recorder is meeting-recorder.ts).
 *
 *   meeting:system-start          after the microphone is open: on macOS the
 *                                 ScreenCaptureKit helper starts here and
 *                                 its frames go to the recorder as "them";
 *                                 on Windows and Linux the answer tells the
 *                                 page how to capture it itself
 *   meeting:system-audio          (send) a Windows / Linux frame of the call's sound
 *   meeting:system-stop           the capture ends (Stop, Delete, the page going)
 *   meeting:open-screen-settings  macOS Privacy, Screen and System Audio Recording
 *
 * `wireMeetingLoopback` answers the page's getDisplayMedia on Windows with
 * the first screen and WASAPI loopback audio, only while a meeting is being
 * recorded; the page drops the video track at once. Elsewhere it refuses.
 *
 * Events go out beside the recorder's on `app:meeting`:
 *   {type: "system", id, state}   ready | screen-denied | no-display | failed | exited
 */
import { app, desktopCapturer, ipcMain, shell, type Session } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { readMeetingPrefs } from "./meeting-prefs.js";
import type { MeetingRecorder } from "./meeting-recorder.js";
import { MacSystemAudio, systemAudioMode } from "./meeting-system-audio.js";

/** electron-builder's appId: this app and its helper processes are left out of the capture. */
export const APP_BUNDLE_ID = "io.atomicagent.desktop";
export const SCREEN_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
/** How long the helper gets to say ready or why not. */
const START_WAIT_MS = 6_000;

export function systemAudioHelperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "native", "atomic-system-audio")
    : join(__dirname, "..", "native", "atomic-system-audio");
}

/** The permission gate's answer for `display-capture`: only Windows loopback, only while recording. */
export function displayCaptureAllowed(armed: boolean, platform: NodeJS.Platform = process.platform): boolean {
  return armed && systemAudioMode(platform) === "loopback";
}

export interface MeetingSystemDeps {
  emit: (ev: unknown) => void;
  platform?: NodeJS.Platform;
  /** Off in Settings, Meetings: microphone only. Defaults to meetings.json. */
  enabled?: () => boolean;
}

export function wireMeetingSystemIpc(recorder: MeetingRecorder, deps: MeetingSystemDeps): void {
  const platform = deps.platform ?? process.platform;
  // Settings, Meetings: Record the other side of the call (on by default).
  const enabled = deps.enabled ?? (() => readMeetingPrefs(app.getPath("userData")).systemAudio);
  let capture: MacSystemAudio | null = null;
  const stop = () => { capture?.stop(); capture = null; };

  ipcMain.handle("meeting:system-start", async (event) => {
    const mode = systemAudioMode(platform);
    const id = recorder.status().id;
    if (!recorder.armed || !id) return { ok: false, mode, error: "not-recording" };
    if (!enabled()) return { ok: false, mode, error: "off" };
    if (mode !== "helper") return { ok: mode !== "none", mode, ...(mode === "none" ? { error: "unsupported" } : {}) };
    const command = systemAudioHelperPath();
    if (!existsSync(command)) return { ok: false, mode, error: "system-helper-missing" };
    stop();
    const state = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("failed"), START_WAIT_MS);
      const mine = new MacSystemAudio({
        command,
        excludeBundle: APP_BUNDLE_ID,
        onFrame: (frame, peak) => {
          // The recording ended in main (the disk, the window): the helper goes too.
          if (!recorder.armed) { if (capture === mine) stop(); return; }
          recorder.audio(frame, peak, "them");
        },
        onState: (st) => {
          clearTimeout(timer);
          resolve(st);
          if (st !== "ready") { if (capture === mine) capture = null; deps.emit({ type: "system", id, state: st }); }
        },
      });
      capture = mine;
      if (!mine.start()) { clearTimeout(timer); resolve("failed"); }
    });
    if (state !== "ready") { stop(); return { ok: false, mode, error: state }; }
    event.sender.once("destroyed", stop);
    return { ok: true, mode };
  });

  ipcMain.on("meeting:system-audio", (_event, chunk: unknown, peak: unknown) => recorder.audio(chunk, peak, "them"));
  ipcMain.handle("meeting:system-stop", () => { stop(); return { ok: true }; });
  ipcMain.handle("meeting:open-screen-settings", async () => {
    if (platform !== "darwin") return { ok: false };
    await shell.openExternal(SCREEN_SETTINGS_URL).catch(() => undefined);
    return { ok: true };
  });
  app.on("will-quit", stop);
}

/** Windows: getDisplayMedia from the page gets the screen plus loopback audio while a meeting records. */
export function wireMeetingLoopback(session: Session, armed: () => boolean, platform: NodeJS.Platform = process.platform): void {
  session.setDisplayMediaRequestHandler((request, callback) => {
    if (!displayCaptureAllowed(armed(), platform) || !request.audioRequested) { callback({}); return; }
    desktopCapturer.getSources({ types: ["screen"] }).then(
      (sources) => { const screen = sources[0]; callback(screen ? { video: screen, audio: "loopback" } : {}); },
      () => callback({}),
    );
  });
}
