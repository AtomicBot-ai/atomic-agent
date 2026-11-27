/**
 * ATO-2333: the "Record a meeting" routes (renderer/meeting-panel.js; the
 * recorder is meeting-recorder.ts).
 *
 *   meeting:available    can the transcriber run here (and in which language)
 *   meeting:start        asks macOS for the microphone when it never has, then
 *                        opens a meeting; from now on the window's audio-only
 *                        getUserMedia is allowed (main.ts voicePermissionVerdict
 *                        reads `recorder.armed`)
 *   meeting:audio        (send) one 100 ms frame and its peak
 *   meeting:stop         the person's Stop: the microphone gate closes at once
 *   meeting:status       is a recording open (a reloaded page asks)
 *   meeting:finish       Done: the saved transcript `{path, fileName, document}`
 *   meeting:discard      Delete: the meeting's audio and text are gone
 *   meeting:recoverable  meetings left on disk by a crash or a closed window
 *   meeting:reveal       the saved transcript in Finder / Explorer
 *
 * Events go out on `app:meeting` (segments, a refused chunk, stopped).
 *
 * Kept on this computer: the audio of a meeting in <userData>/meetings/<id>
 * only until each chunk is transcribed; the transcript in
 * <Documents>/Atomic Agent/Meetings. A recording whose window goes away is
 * stopped, never left listening.
 */
import { app, ipcMain, shell, systemPreferences } from "electron";
import { join, relative, resolve, isAbsolute } from "node:path";

import { MeetingRecorder, type MeetingEvent } from "./meeting-recorder.js";
import { MeetingStore } from "./meeting-store.js";
import type { TranscribeEngine } from "./transcribe-file.js";

/** Where finished transcripts are saved: a plain folder the person can open, add to My files, or delete. */
export function meetingSaveDir(): string {
  return join(app.getPath("documents"), "Atomic Agent", "Meetings");
}

/** The recorder main.ts keeps beside `voice`: its `armed` is read by the microphone gate. */
export function meetingRecorderFor(engine: TranscribeEngine, emit: (ev: MeetingEvent) => void): MeetingRecorder {
  return new MeetingRecorder({
    store: new MeetingStore(() => join(app.getPath("userData"), "meetings")),
    engine,
    saveDir: meetingSaveDir,
    emit,
  });
}

function inside(folder: string, path: string): boolean {
  const rel = relative(resolve(folder), resolve(path));
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

export function wireMeetingIpc(recorder: MeetingRecorder, platform: NodeJS.Platform = process.platform): void {
  ipcMain.handle("meeting:available", () => recorder.available());

  ipcMain.handle("meeting:start", async (event) => {
    if (platform === "darwin" && systemPreferences.getMediaAccessStatus("microphone") !== "granted") {
      const granted = await systemPreferences.askForMediaAccess("microphone").catch(() => false);
      if (!granted) return { ok: false, error: "mic-denied" };
    }
    const res = await recorder.start();
    if (res.ok && res.id) {
      const id = res.id;
      const sender = event.sender;
      // The page that holds the microphone is gone: the recording stops, kept for Finish.
      // A reload keeps the same page object; the reloaded page asks meeting:status and stops it.
      const end = () => { if (recorder.status().id === id) recorder.stop("window"); };
      sender.once("destroyed", end);
      sender.once("render-process-gone", end);
    }
    return res;
  });

  ipcMain.on("meeting:audio", (_event, chunk: unknown, peak: unknown) => recorder.audio(chunk, peak));
  ipcMain.handle("meeting:stop", () => recorder.stop("user"));
  ipcMain.handle("meeting:status", () => recorder.status());
  ipcMain.handle("meeting:finish", (_event, id: unknown) => recorder.finish(id));
  ipcMain.handle("meeting:discard", (_event, id: unknown) => recorder.discard(id));
  ipcMain.handle("meeting:recoverable", () => recorder.recoverable());
  ipcMain.handle("meeting:reveal", (_event, path: unknown) => {
    if (typeof path !== "string" || !inside(meetingSaveDir(), path)) return { ok: false };
    shell.showItemInFolder(path);
    return { ok: true };
  });

  // Quit: nothing listens any more; what was recorded is on disk for next time.
  app.on("will-quit", () => recorder.kill());
}
