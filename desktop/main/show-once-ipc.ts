import { join } from "node:path";
import { BrowserWindow, app, ipcMain, shell, systemPreferences, type Tray } from "electron";

import { loadUiohook } from "./hold-key-uiohook.js";
import { registerPrivacyPaneIpc } from "./privacy-pane.js";
import { pendingDraftsRoot } from "./show-once-draft.js";
import { saveRecording, tidyDraft, type CompleteFn } from "./show-once-finish.js";
import type { ShowOnceHelperPush } from "./show-once-helper.js";
import { SHOW_ONCE_LIMITS, ShowOnceLog, isShowOnceAction, type ShowOnceEvent, type ShowOnceRect } from "./show-once-log.js";
import type { ShowOnceOptions } from "./show-once-options.js";
import { hasXdotool } from "./show-once-linux.js";
import { showOnceGate, showOnceOsName, showOnceSupport, type ShowOnceSupport } from "./show-once-platform.js";
import { openShowOnceProber, type ShowOnceProber } from "./show-once-prober.js";
import { wireShowOnceReviewIpc } from "./show-once-review-ipc.js";
import { ShowOnceSnapshots } from "./show-once-snapshots.js";
import { startShowOnceCapture, startShowOnceHook, type HookKey, type HookMouse, type ShowOnceHook } from "./show-once-start.js";
import { showOnceTray } from "./show-once-tray.js";

/**
 * ATO-2401 "Show once" (Settings › Skills): Record, do a routine once in an
 * app, Stop, and the steps are saved as a skill draft under To review.
 * Routes: showOnce:state (what the card draws, also pushed on each change),
 * showOnce:start (`{ok:false, reason}` when it cannot), showOnce:stop (saves,
 * show-once-finish.ts), showOnce:cancel (keeps nothing). The switches, a
 * draft's pictures and the permission panes: show-once-review-ipc.ts.
 *
 * Opt-in and visible: nothing listens until Record is clicked, and while it
 * records a menu bar item says so (show-once-tray.ts); when that item
 * cannot be shown, nothing records (show-once-start.ts). It stops on its
 * own after SHOW_ONCE_LIMITS.maxDurationMs or maxSteps, and on quit
 * (keeping nothing).
 *
 * Kept: the step log in memory (no characters typed, nothing in protected
 * apps, show-once-log.ts), then the draft's SKILL.md and draft.json in
 * `<stateDir>/skills-pending/<id>/`, plus, when switched on, pictures of the
 * window after each step in apps that are neither browsers nor protected
 * (show-once-snapshots.ts). Discard in To review deletes all of it.
 *
 * The listener is uiohook-napi (on macOS it needs Accessibility). ATO-2499:
 * what was under each event comes from show-once-prober.ts, the helper's
 * window and menu events go into the log in order, and after the save the
 * chat model tidies the draft when that switch is on. Windows and Linux
 * (X11) record too; show-once-platform.ts says when this one cannot.
 */

type Deps = {
  stateDir: string;
  isRemote: () => boolean;
  log: (line: string) => void;
  /** ATO-2499: the agent's POST /api/complete (agent-client.ts plainComplete), for the tidy pass. */
  complete?: CompleteFn;
};

export type ShowOnceLast =
  | { kind: "saved"; id: string; name: string; steps: number; pictures: number; tidy: "off" | "running" | "done" | "failed"; tidyError?: string }
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
  options: ShowOnceOptions;
  /** Pictures need macOS Screen Recording for the app: false shows the hint and its button. */
  screenAllowed: boolean;
  /** ATO-2499: "macOS", "Windows" or "Linux"; and why Record cannot run here (Wayland, no xdotool), else null. */
  os: string;
  unsupported: string | null;
}

type Aim = { windowId?: number | null; rect?: ShowOnceRect | null };

export function wireShowOnceIpc(deps: Deps): { stopAndDiscard: () => void } {
  let hook: ShowOnceHook | null = null;
  let tray: Tray | null = null;
  let log: ShowOnceLog | null = null;
  let shots: ShowOnceSnapshots | null = null;
  let startedAt: number | null = null;
  let saving = false;
  let last: ShowOnceLast | null = null;
  let timer: NodeJS.Timeout | null = null;
  let chain: Promise<void> = Promise.resolve();
  let prober: ShowOnceProber | null = null;
  let support: ShowOnceSupport | null = null; // asked again on each Record (xdotool may be installed since)
  const supportNow = () => (support ??= showOnceSupport(process.platform, process.env, hasXdotool));
  const review = wireShowOnceReviewIpc({ stateDir: deps.stateDir, isRemote: deps.isRemote, log: deps.log, changed: () => broadcast() });
  const nativeDir = () => (app.isPackaged ? join(process.resourcesPath, "native") : join(__dirname, "..", "native"));
  const screenAllowed = () => {
    try { return systemPreferences.getMediaAccessStatus("screen") === "granted"; } catch { return false; }
  };

  const state = (): ShowOnceState => ({
    available: ["darwin", "win32", "linux"].includes(process.platform) && !deps.isRemote(),
    recording: hook !== null,
    saving,
    steps: log ? log.actionCount : 0,
    app: log ? log.currentApp : null,
    startedAt,
    last,
    draftsDir: pendingDraftsRoot(deps.stateDir),
    options: review.options(),
    screenAllowed: process.platform === "darwin" ? screenAllowed() : false,
    os: showOnceOsName(process.platform),
    unsupported: (() => { const s = supportNow(); return s.ok ? null : s.message; })(),
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

  const feed = (e: ShowOnceEvent, aim?: Aim) => {
    if (!log) return;
    const changed = log.add(e);
    if (changed && shots && aim) {
      // The window after a step a person did, in an app that is neither a browser nor protected.
      const step = log.steps[log.steps.length - 1];
      const inApp = [...log.steps].reverse().find((s) => s.kind === "app" || s.kind === "protected");
      if (isShowOnceAction(step) && inApp && inApp.kind === "app" && !inApp.browser) shots.take(log.steps.length, aim);
    }
    broadcast();
    if (log.full) void finish(true); // the step cap: stop and save what is there
  };
  const onMouse = (e: HookMouse) => {
    if (!hook) return;
    const at = Date.now();
    const button: "left" | "right" | null = e.button === 1 ? "left" : e.button === 2 ? "right" : null;
    if (!button) return;
    chain = chain.then(async () => {
      const pr = prober;
      if (!pr) return;
      const p = await pr.click(e.x, e.y);
      feed({ kind: "click", at, x: e.x, y: e.y, button, clicks: e.clicks || 1, app: p.app, window: p.window, element: p.element, windowTitle: p.windowTitle },
        { windowId: p.windowId, rect: p.window });
    }).catch(() => {});
  };
  const onKey = (e: HookKey) => {
    if (!hook) return;
    const at = Date.now();
    // Only the key code and the modifiers go further: the log keeps no character.
    const k = { keycode: e.keycode, meta: !!e.metaKey, ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey };
    chain = chain.then(async () => {
      const pr = prober;
      if (!pr) return;
      const p = await pr.key(at);
      feed({ kind: "key", at, ...k, app: p.app, focused: p.focused, windowTitle: p.windowTitle }, { windowId: p.windowId });
      // Tab and return move the focus: the next key asks again.
      if (k.keycode === 15 || k.keycode === 28) pr.forgetKey();
    }).catch(() => {});
  };
  // The helper's window and menu events, in line behind the clicks heard before them.
  const onPush = (push: ShowOnceHelperPush) => {
    if (!hook) return;
    const at = Date.now();
    chain = chain.then(() => {
      feed(push.kind === "menu" ? { kind: "menu", at, app: push.app, path: push.path } : { kind: "window", at, app: push.app, title: push.title });
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
    // The events already heard still ask their question; then the helper goes.
    const p = prober;
    const done = () => {
      if (!p) return;
      p.stop();
      if (prober === p) prober = null;
    };
    void chain.then(done, done);
  };

  const start = (): { ok: true } | { ok: false; reason: string; error: string } => {
    if (hook) return { ok: true };
    support = null;
    const gate = showOnceGate({ platform: process.platform, remote: deps.isRemote(), support: supportNow(),
      axTrusted: (prompt) => systemPreferences.isTrustedAccessibilityClient(prompt) });
    if (!gate.ok) {
      if (gate.permission) last = { kind: "error", error: gate.error, permission: true };
      broadcast();
      return { ok: false, reason: gate.reason, error: gate.error };
    }
    // The menu bar item first, the listener second: recording never runs unseen.
    const started = startShowOnceCapture<ShowOnceHook, Tray>({
      showIndicator: () => showOnceTray(() => void finish(true), () => void finish(false)),
      startListener: () => startShowOnceHook(loadUiohook() as unknown as ShowOnceHook, onMouse, onKey),
    });
    if (!started.ok) {
      const what = started.stage === "indicator" ? "could not show the menu bar item" : "could not start the listener";
      deps.log(`[desktop] show once: ${what}: ${started.message}`);
      const error = "Could not start recording on this computer.";
      last = { kind: "error", error };
      broadcast();
      return { ok: false, reason: "failed", error };
    }
    hook = started.hook;
    tray = started.indicator;
    log = new ShowOnceLog(process.pid, process.platform);
    startedAt = Date.now();
    // Pictures only with the switch on and Screen Recording allowed (else macOS gives a blank desktop).
    shots = process.platform === "darwin" && review.options().snapshots && screenAllowed() ? new ShowOnceSnapshots(join(deps.stateDir, "show-once-shots", String(startedAt))) : null;
    last = null;
    chain = openShowOnceProber({ nativeDir: nativeDir(), platform: process.platform, onPush, log: deps.log })
      .then((p) => {
        if (hook) prober = p;
        else p.stop(); // stopped while the helper was starting
      }, () => {});
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
    const steps = log ? [...log.steps] : [];
    const recordedAt = new Date(startedAt ?? Date.now());
    const pictures = shots;
    log = null;
    shots = null;
    startedAt = null;
    if (!save) {
      await pictures?.discard();
      last = { kind: "cancelled" };
      broadcast();
      return state();
    }
    let saved: Awaited<ReturnType<typeof saveRecording>> | null = null;
    try {
      saved = await saveRecording(deps.stateDir, steps, recordedAt, pictures, showOnceOsName(process.platform));
      last = saved.kind === "empty" ? { kind: "empty" }
        : { kind: "saved", id: saved.id, name: saved.name, steps: saved.steps, pictures: saved.pictures, tidy: review.options().tidy && deps.complete ? "running" : "off" };
    } catch (err) {
      deps.log(`[desktop] show once: could not save the draft: ${err instanceof Error ? err.message : String(err)}`);
      last = { kind: "error", error: "Could not save the recording as a skill draft." };
    }
    saving = false;
    broadcast();
    const mine = last;
    if (saved && saved.kind === "saved" && mine && mine.kind === "saved" && mine.tidy === "running" && deps.complete) {
      const res = await tidyDraft(deps.complete, saved, steps, recordedAt, deps.log, showOnceOsName(process.platform));
      // A newer recording's line is not overwritten by this one's tidy.
      if (last === mine) {
        last = res.ok ? { ...mine, tidy: "done" } : res.gone ? { ...mine, tidy: "off" } : { ...mine, tidy: "failed", tidyError: res.error };
        broadcast();
      }
    }
    return state();
  }

  ipcMain.handle("showOnce:state", () => state());
  ipcMain.handle("showOnce:start", () => start());
  ipcMain.handle("showOnce:stop", () => finish(true));
  ipcMain.handle("showOnce:cancel", () => finish(false));
  // ATO-2744: the named Privacy panes (Full Disk Access for My files, Input Monitoring for Show once).
  registerPrivacyPaneIpc({ ipcMain, openExternal: (url) => shell.openExternal(url), platform: process.platform });
  app.on("before-quit", () => {
    if (!hook) return;
    release();
    void shots?.discard();
    log = null;
    shots = null;
    startedAt = null;
  });
  return { stopAndDiscard: () => void finish(false) };
}
