/**
 * ATO-2514: telling speakers apart by voice, the electron half
 * (meeting-voices.ts holds the logic).
 *
 *   meeting:voices-status   {enabled, downloading, known, supported, installed, downloadBytes}
 *   meeting:voices-install  the first-use download (also started by a meeting)
 *   meeting:voices-cancel   stops a running download
 *   meeting:voices-remove   deletes the diarizer and its models
 *
 * Progress goes out on `app:meeting` as {type: "voices", state, fraction}.
 * The work is `atomic-agent diarize …` (the agent's src/tools/audio), run
 * like `whisper install`: the bundled agent binary, its environment, no shell.
 * Every child it starts is stopped when the app quits.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { app, ipcMain } from "electron";

import { resolveBinary } from "./agent-client.js";
import { readMeetingPrefs } from "./meeting-prefs.js";
import { MeetingVoices, type VoicesCli, type VoicesEvent } from "./meeting-voices.js";
import { agentEnv } from "./state-dir.js";

const children = new Set<ChildProcess>();

/** `atomic-agent <args>`, stdout line by line. An agent from before `diarize` simply answers not ok. */
export const agentDiarizeCli: VoicesCli = (args, onLine, signal) => new Promise((resolve) => {
  const binary = resolveBinary();
  if (!binary) { resolve({ ok: false }); return; }
  let child: ChildProcess;
  try {
    child = spawn(binary, args, { env: agentEnv(), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  } catch {
    resolve({ ok: false });
    return;
  }
  children.add(child);
  const kill = () => { try { child.kill(); } catch { /* gone */ } };
  signal?.addEventListener("abort", kill, { once: true });
  let pending = "";
  child.stdout?.on("data", (c: Buffer) => {
    pending += c.toString("utf8");
    let nl = pending.indexOf("\n");
    while (nl >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (line) onLine(line);
      nl = pending.indexOf("\n");
    }
  });
  const done = (ok: boolean) => {
    children.delete(child);
    signal?.removeEventListener("abort", kill);
    if (pending.trim()) onLine(pending.trim());
    pending = "";
    resolve({ ok });
  };
  child.on("error", () => done(false));
  child.on("exit", (code) => done(code === 0));
});

let shared: MeetingVoices | null = null;

/** The one MeetingVoices of the app; the recorder and the routes share it. */
export function meetingVoicesFor(emit: (ev: VoicesEvent) => void): MeetingVoices {
  if (!shared) {
    shared = new MeetingVoices({ cli: agentDiarizeCli, enabled: () => readMeetingPrefs(app.getPath("userData")).voices, emit });
  }
  return shared;
}

export function wireMeetingVoicesIpc(voices: MeetingVoices): void {
  ipcMain.handle("meeting:voices-status", async () => ({
    ...(await voices.status(true)),
    enabled: voices.enabled(),
    downloading: voices.downloading,
  }));
  ipcMain.handle("meeting:voices-install", () => voices.install());
  ipcMain.handle("meeting:voices-cancel", () => { voices.cancel(); return { ok: true }; });
  ipcMain.handle("meeting:voices-remove", () => voices.remove());
  app.on("will-quit", () => {
    voices.cancel();
    for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  });
}
