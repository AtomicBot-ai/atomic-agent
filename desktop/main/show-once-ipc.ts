import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, shell, systemPreferences } from "electron";

import { loadUiohook } from "./hold-key-uiohook.js";
import { pendingDraftsRoot, saveShowOnceDraft } from "./show-once-draft.js";
import { SHOW_ONCE_LIMITS, ShowOnceLog, type ShowOnceEvent } from "./show-once-log.js";
import { runShowOnceProbe, type ShowOnceProbe } from "./show-once-probe.js";
import { compileShowOnceSkill } from "./show-once-skill.js";

/**
 * ATO-2401 "Show once" (Settings › Skills): Record, do a routine once in a
 * Mac app, Stop, and the steps are saved as a skill draft under Pending
 * review. Routes:
 *
 *   showOnce:state     → what the card draws (below)
 *   showOnce:start     → starts recording; `{ok:false, reason}` when it cannot
 *   showOnce:stop      → stops and saves the draft (show-once-draft.ts)
 *   showOnce:cancel    → stops and keeps nothing
 *   showOnce:openAccessibility → macOS's Accessibility pane
 *   "showOnce:state" is also pushed to every window on each change.
 *
 * Opt-in and visible: nothing listens until Record is clicked, and while it
 * records a menu bar item says so ("● Recording steps"). One click on it
 * stops and saves; its right-click menu also offers Discard. The recording
 * stops on its own after SHOW_ONCE_LIMITS.maxDurationMs or maxSteps, and
 * when the app quits (keeping nothing).
 *
 * Kept: the step log in memory while recording (no characters typed,
 * nothing in protected apps, show-once-log.ts), then only the draft's
 * SKILL.md and draft.json in `<stateDir>/skills-pending/<id>/`. No
 * screenshots, no audio. Discard in Pending review deletes the draft.
 *
 * The listener is uiohook-napi (the module the Windows hold key already
 * uses), here on macOS, which needs Accessibility for Atomic Agent.
 */

type Deps = { stateDir: string; isRemote: () => boolean; log: (line: string) => void };

interface HookMouse { button: number; clicks: number; x: number; y: number }
interface HookKey { keycode: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }
interface ShowOnceHook {
  on(event: "mousedown", fn: (e: HookMouse) => void): unknown;
  on(event: "keydown", fn: (e: HookKey) => void): unknown;
  removeListener(event: "mousedown" | "keydown", fn: (e: never) => void): unknown;
  start(): void;
  stop(): void;
}

export type ShowOnceLast =
  | { kind: "saved"; id: string; name: string; steps: number }
  | { kind: "empty" }
  | { kind: "cancelled" }
  | { kind: "error"; error: string; permission?: boolean };

export interface ShowOnceState {
  available: boolean;
  recording: boolean;
  saving: boolean;
  steps: number;
  app: string | null;
  startedAt: number | null;
  last: ShowOnceLast | null;
  draftsDir: string;
}

const KEY_PROBE_FRESH_MS = 1500;

export function wireShowOnceIpc(deps: Deps): { stopAndDiscard: () => void } {
  let hook: ShowOnceHook | null = null;
  let tray: Tray | null = null;
  let log: ShowOnceLog | null = null;
  let startedAt: number | null = null;
  let saving = false;
  let last: ShowOnceLast | null = null;
  let timer: NodeJS.Timeout | null = null;
  let chain: Promise<void> = Promise.resolve();
  let keyProbe: { at: number; probe: ShowOnceProbe } | null = null;

  const state = (): ShowOnceState => ({
    available: process.platform === "darwin" && !deps.isRemote(),
    recording: hook !== null,
    saving,
    steps: log ? log.actionCount : 0,
    app: log ? log.currentApp : null,
    startedAt,
    last,
    draftsDir: pendingDraftsRoot(deps.stateDir),
  });
  const broadcast = () => {
    const payload = state();
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (!w.isDestroyed()) w.webContents.send("showOnce:state", payload);
      } catch { /* a window going away */ }
    }
    if (tray && log) tray.setToolTip(`Show once is recording: ${log.actionCount} steps. Click to stop and save.`);
  };

  const feed = (e: ShowOnceEvent) => {
    if (!log) return;
    log.add(e);
    broadcast();
    if (log.full) void finish(true); // the step cap: stop and save what is there
  };
  const onMouse = (e: HookMouse) => {
    if (!hook) return;
    const at = Date.now();
    const button: "left" | "right" | null = e.button === 1 ? "left" : e.button === 2 ? "right" : null;
    if (!button) return;
    keyProbe = null; // the focus may move with the click
    chain = chain.then(async () => {
      const p = await runShowOnceProbe("click", e.x, e.y);
      feed({ kind: "click", at, x: e.x, y: e.y, button, clicks: e.clicks || 1, app: p.app, window: p.window, element: p.element });
    }).catch(() => {});
  };
  const onKey = (e: HookKey) => {
    if (!hook) return;
    const at = Date.now();
    // Only the key code and the modifiers go further: the log keeps no character.
    const k = { keycode: e.keycode, meta: !!e.metaKey, ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey };
    chain = chain.then(async () => {
      if (!keyProbe || at - keyProbe.at > KEY_PROBE_FRESH_MS) keyProbe = { at, probe: await runShowOnceProbe("key") };
      const p = keyProbe.probe;
      feed({ kind: "key", at, ...k, app: p.app, focused: p.focused });
      // Tab and return move the focus: the next key asks again.
      if (k.keycode === 15 || k.keycode === 28) keyProbe = null;
    }).catch(() => {});
  };

  const release = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const h = hook;
    hook = null;
    if (h) {
      try { h.removeListener("mousedown", onMouse as (e: never) => void); h.removeListener("keydown", onKey as (e: never) => void); } catch { /* gone */ }
      try { h.stop(); } catch { /* gone */ }
    }
    if (tray) {
      try { tray.destroy(); } catch { /* gone */ }
      tray = null;
    }
    keyProbe = null;
  };

  const start = (): { ok: true } | { ok: false; reason: string; error: string } => {
    if (hook) return { ok: true };
    if (process.platform !== "darwin") return { ok: false, reason: "platform", error: "Show once records Mac apps; it is not on this system yet." };
    if (deps.isRemote()) return { ok: false, reason: "remote", error: "Show once records on the computer that runs the agent." };
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      systemPreferences.isTrustedAccessibilityClient(true); // macOS shows its own prompt
      const error = "Allow Atomic Agent in System Settings › Privacy & Security › Accessibility, then click Record again.";
      last = { kind: "error", error, permission: true };
      broadcast();
      return { ok: false, reason: "permission", error };
    }
    let h: ShowOnceHook;
    try {
      h = loadUiohook() as unknown as ShowOnceHook;
      h.on("mousedown", onMouse);
      h.on("keydown", onKey);
      h.start();
    } catch (err) {
      const msg = err instanceof Error ? err.message.split(/\r?\n/)[0] : String(err);
      deps.log(`[desktop] show once: could not start the listener: ${String(msg).slice(0, 200)}`);
      const error = "Could not start recording on this Mac.";
      last = { kind: "error", error };
      broadcast();
      return { ok: false, reason: "failed", error };
    }
    hook = h;
    log = new ShowOnceLog(process.pid);
    startedAt = Date.now();
    last = null;
    chain = Promise.resolve();
    try {
      tray = new Tray(nativeImage.createEmpty());
      tray.setTitle(" ● Recording steps");
      tray.on("click", () => void finish(true));
      tray.on("right-click", () => {
        tray?.popUpContextMenu(Menu.buildFromTemplate([
          { label: "Stop and save as a skill draft", click: () => void finish(true) },
          { label: "Discard this recording", click: () => void finish(false) },
        ]));
      });
    } catch (err) {
      deps.log(`[desktop] show once: no menu bar indicator: ${err instanceof Error ? err.message : String(err)}`);
    }
    timer = setTimeout(() => void finish(true), SHOW_ONCE_LIMITS.maxDurationMs);
    broadcast();
    return { ok: true };
  };

  async function finish(save: boolean): Promise<ShowOnceState> {
    if (!hook || saving) return state();
    release();
    saving = save;
    broadcast();
    await chain.catch(() => {}); // the events already heard go in first
    const steps = log ? log.steps : [];
    const recordedAt = new Date(startedAt ?? Date.now());
    log = null;
    startedAt = null;
    if (!save) {
      last = { kind: "cancelled" };
      broadcast();
      return state();
    }
    try {
      const skill = compileShowOnceSkill(steps, recordedAt);
      if (!skill) {
        last = { kind: "empty" };
      } else {
        const count = steps.filter((s) => s.kind === "click" || s.kind === "keys" || s.kind === "text").length;
        const saved = await saveShowOnceDraft(deps.stateDir, { name: skill.name, reason: skill.description, content: skill.content });
        last = { kind: "saved", id: saved.id, name: skill.name, steps: count };
      }
    } catch (err) {
      deps.log(`[desktop] show once: could not save the draft: ${err instanceof Error ? err.message : String(err)}`);
      last = { kind: "error", error: "Could not save the recording as a skill draft." };
    }
    saving = false;
    broadcast();
    return state();
  }

  ipcMain.handle("showOnce:state", () => state());
  ipcMain.handle("showOnce:start", () => start());
  ipcMain.handle("showOnce:stop", () => finish(true));
  ipcMain.handle("showOnce:cancel", () => finish(false));
  ipcMain.handle("showOnce:openAccessibility", () =>
    shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility").then(() => true, () => false));
  app.on("before-quit", () => { if (hook) { release(); log = null; startedAt = null; } });
  return { stopAndDiscard: () => void finish(false) };
}
