import { app, BrowserWindow, globalShortcut, ipcMain, Notification, screen, session, shell, systemPreferences } from "electron";
import { join } from "node:path";

import {
  DictateTake,
  dictateClash,
  dictateFinishTimeoutMs,
  dictatePillBounds,
  dictateUnavailableReason,
  mergeDictatePref,
  pickDictateLocales,
  readDictatePref,
  writeDictatePref,
  type DictatePref,
} from "./dictate-anywhere.js";
import {
  HoldMachine,
  dictatePrivacyUrl,
  holdKeyCommand,
  holdKeyLabel,
  holdKeyNote,
  holdWatchFailed,
  holdWatchLine,
  type HoldAction,
} from "./dictate-hold.js";
import { HoldKeyWatcher } from "./hold-key-watcher.js";
import { keystrokesAllowed, pasteIntoFrontApp } from "./keystroke-clipboard-host.js";
import {
  SHORTCUT_TAKEN_MESSAGE,
  acceleratorLabel,
  quickEntrySkipReason,
  quickEntryStateLine,
  quickEntryWindowLevel,
  QuickEntryShortcut,
} from "./quick-entry.js";
import { VoiceSession } from "./speech.js";

/**
 * The Electron half of ATO-1064 (dictate-anywhere.ts holds the rest).
 *
 * A take has its own VoiceSession, never the composer's (main.ts `voice`):
 * the composer's microphone and this hotkey cannot end each other's take,
 * and speech.ts is only called, not changed. The pill is the page that
 * holds the microphone, in its own session partition whose permission
 * handlers allow audio only while THIS take is armed, as main.ts does for
 * the main window. It never takes the keyboard (not focusable, shown
 * inactive), so the app in front stays in front and gets the paste.
 *
 * Two ways in: the hold key (dictate-hold.ts: a watcher process, its
 * down/up through HoldMachine) or the toggle combo (globalShortcut). In the
 * hold mode the combo stands in while the watcher cannot run (no
 * Accessibility yet, a build without the helper), so the switch never
 * turns on to nothing.
 */

const PARTITION = "dictate-anywhere";
const MAC_HINT = "Typing into other apps needs Accessibility: System Settings › Privacy & Security › Accessibility, then turn on Atomic Agent.";

export interface DictateWiring {
  userData: string;
  platform: NodeJS.Platform;
  smoke: boolean;
  probe: boolean;
  modelsTest: boolean;
  /** The composer's chosen dictation languages (main.ts readVoicePrefs). */
  locales: () => string[];
  /** The quick-entry box's combo, so the two never share one. */
  quickEntryAccelerator: () => string | null;
  log: (line: string) => void;
}

type Phase = "idle" | "starting" | "listening" | "finishing";

const pills = new WeakSet<BrowserWindow>();

/** True for the dictation pill: not "a window of the app" for the Dock reopen. */
export function isDictatePill(win: BrowserWindow): boolean {
  return pills.has(win);
}

export function wireDictateAnywhere(w: DictateWiring): { dispose: () => void } {
  const voice = new VoiceSession();
  let pref: DictatePref = readDictatePref(w.userData, w.platform);
  let phase: Phase = "idle";
  let take: DictateTake | null = null;
  let pill: BrowserWindow | null = null;
  let finishTimer: NodeJS.Timeout | null = null;
  let escHeld = false;
  /** The hold key came up while the take was still starting: finish it as soon as it listens. */
  let finishOnListen = false;

  const notify = (body: string) => {
    w.log(`[desktop] dictate anywhere: ${body}`);
    try { if (Notification.isSupported()) new Notification({ title: "Dictation", body, silent: true }).show(); } catch { /* no notifications */ }
  };
  const tell = (payload: Record<string, unknown>) => {
    if (pill && !pill.isDestroyed()) pill.webContents.send("app:dictate", payload);
  };

  const part = session.fromPartition(PARTITION);
  const allowed = (wc: Electron.WebContents | null, permission: string, types: string[] | undefined) =>
    permission === "media" && voice.armed && !!pill && !pill.isDestroyed() && wc === pill.webContents
      && !!types && types.length > 0 && types.every((t) => t === "audio");
  part.setPermissionRequestHandler((wc, permission, callback, details) =>
    callback(allowed(wc, permission, (details as unknown as { mediaTypes?: string[] }).mediaTypes)));
  part.setPermissionCheckHandler((wc, permission, _origin, details) =>
    allowed(wc, permission, (details as unknown as { mediaTypes?: string[] }).mediaTypes));

  const releaseEsc = () => {
    if (!escHeld) return;
    escHeld = false;
    try { globalShortcut.unregister("Escape"); } catch { /* already gone */ }
  };
  const closePill = () => {
    releaseEsc();
    if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
    const p = pill;
    pill = null;
    if (p && !p.isDestroyed()) p.destroy();
  };
  const reset = () => { closePill(); take = null; phase = "idle"; finishOnListen = false; };

  const cancel = () => {
    if (phase === "idle") return;
    voice.cancel();
    reset();
  };

  /** The take's words into the app in front. The pill goes first, so nothing of ours is in the way. */
  const deliver = async (t: DictateTake | null) => {
    reset();
    const text = t?.text() ?? "";
    if (!text) { if (t?.error) notify(t.error); return; }
    const out = await pasteIntoFrontApp(text);
    if (!out.pasted) {
      notify(w.platform === "darwin" && !keystrokesAllowed(false)
        ? "The text is on the clipboard: press ⌘V. " + MAC_HINT
        : "The text is on the clipboard: paste it where you want it.");
    }
  };

  const onEvent = (payload: Record<string, unknown>) => {
    if (!take) return;
    const out = take.apply(payload);
    if (out === "continue") { if (phase === "listening") tell({ phase, text: take.live() }); return; }
    if (out === "cancelled") { reset(); return; }
    if (out === "failed") { const err = take.error; voice.cancel(); reset(); if (err) notify(err); return; }
    void deliver(take);
  };

  const showPill = () => {
    const cursor = screen.getCursorScreenPoint();
    const bounds = dictatePillBounds(cursor, screen.getAllDisplays().map((d) => ({ bounds: d.bounds, workArea: d.workArea })));
    const win = new BrowserWindow({
      ...bounds,
      show: false, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false, hasShadow: true,
      backgroundColor: "#191C21", title: "Dictation",
      ...(w.platform === "darwin" ? { type: "panel" as const } : {}),
      webPreferences: {
        preload: join(__dirname, "..", "preload", "preload.js"),
        partition: PARTITION,
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        autoplayPolicy: "no-user-gesture-required",
      },
    });
    pill = win;
    pills.add(win);
    win.setAlwaysOnTop(true, quickEntryWindowLevel(w.platform));
    if (w.platform === "darwin") win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.on("closed", () => { if (pill === win) cancel(); });
    win.once("ready-to-show", () => { if (!win.isDestroyed()) win.showInactive(); });
    void win.loadFile(join(__dirname, "..", "renderer", "dictate-anywhere.html")).catch(() => {});
    // Esc throws the take away, as long as nothing else of ours holds it (the marks overlay).
    if (!globalShortcut.isRegistered("Escape")) {
      try { escHeld = globalShortcut.register("Escape", cancel); } catch { escHeld = false; }
    }
  };

  const start = async () => {
    phase = "starting";
    const probe = await voice.probe();
    const why = dictateUnavailableReason(probe);
    if (why) { phase = "idle"; notify(why); return; }
    if (w.platform === "darwin" && systemPreferences.getMediaAccessStatus("microphone") !== "granted") {
      const granted = await systemPreferences.askForMediaAccess("microphone").catch(() => false);
      if (!granted) { phase = "idle"; notify("Microphone access is turned off for Atomic Agent."); return; }
    }
    if (phase !== "starting") return;   // disposed meanwhile
    take = new DictateTake();
    const locales = pickDictateLocales(w.locales(), probe.installed, app.getLocale());
    const res = await voice.start(locales, onEvent);
    if (phase !== "starting") { if (res.ok) voice.cancel(); return; }   // cancelled while it started
    if (!res.ok) { reset(); notify("Dictation could not start" + (res.error ? ` (${res.error}).` : ".")); return; }
    phase = "listening";
    showPill();
    if (finishOnListen) { finishOnListen = false; finish(); }
  };

  const finish = () => {
    if (!take) return;
    phase = "finishing";
    take.stop();
    tell({ phase, text: take.live() });
    voice.stop();
    // The end never came: what was heard so far is typed, and the session thrown away.
    finishTimer = setTimeout(() => {
      const t = take;
      take = null;   // the cancel's own "closed" must not end it a second time
      voice.cancel();
      void deliver(t);
    }, dictateFinishTimeoutMs(w.platform));
  };

  const press = () => {
    if (phase === "idle") { void start().catch(() => reset()); return; }
    if (phase === "listening") finish();
  };

  /* The hold key: down past the tap delay starts, up finishes, Esc or a chord cancels. */
  const onHold = (a: HoldAction) => {
    if (a === "start") { if (phase === "idle") void start().catch(() => reset()); return; }
    if (a === "finish") {
      if (phase === "listening") finish();
      else if (phase === "starting") finishOnListen = true;
      return;
    }
    cancel();
  };
  const hold = new HoldMachine({ set: (ms, fn) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as NodeJS.Timeout) }, onHold);
  const nativeDir = app.isPackaged ? join(process.resourcesPath, "native") : join(__dirname, "..", "native");
  const watcher = new HoldKeyWatcher(
    () => holdKeyCommand(w.platform, nativeDir, process.env),
    (line) => {
      if (line.type === "down") hold.down();
      else if (line.type === "up") hold.up();
      else if (line.type === "esc") hold.esc();
      else if (line.type === "other") hold.other();
    },
    (st) => {
      if (st !== "ready") hold.reset();
      if (st === "untrusted" || st === "missing" || st === "failed") w.log(`[desktop] dictate anywhere: hold key watcher ${st}`);
      applyCombo();
    },
    w.log,
  );

  const skip = quickEntrySkipReason({ smoke: w.smoke, probe: w.probe, modelsTest: w.modelsTest, envOff: process.env.ATOMIC_AGENT_NO_GLOBAL_SHORTCUT === "1" });
  const shortcut = new QuickEntryShortcut(
    {
      register: (acc, cb) => globalShortcut.register(acc, cb),
      unregister: (acc) => globalShortcut.unregister(acc),
      isRegistered: (acc) => globalShortcut.isRegistered(acc),
    },
    press,
    skip,
  );

  /** The hold mode needs the watcher; the toggle mode (or a hold key that cannot be watched) the combo. */
  const comboWanted = (p: DictatePref) => p.enabled && (p.mode === "toggle" || holdWatchFailed(watcher.state));
  function applyCombo() {
    return shortcut.apply({ enabled: comboWanted(pref), accelerator: pref.accelerator });
  }
  const applyAll = () => {
    if (pref.enabled && pref.mode === "hold" && !skip) watcher.start();
    else watcher.stop();
    return applyCombo();
  };

  const describe = async () => {
    // Accessibility granted since the watcher said untrusted: a new watcher process sees it.
    if (pref.enabled && pref.mode === "hold" && !skip && watcher.state === "untrusted" && keystrokesAllowed(false)) {
      watcher.stop();
      applyAll();
    }
    const st = shortcut.state();
    const why = dictateUnavailableReason(await voice.probe());
    const label = acceleratorLabel(pref.accelerator, w.platform);
    const holdOn = pref.enabled && pref.mode === "hold";
    return {
      ok: true,
      enabled: pref.enabled,
      mode: pref.mode,
      accelerator: pref.accelerator,
      label,
      holdLabel: holdKeyLabel(w.platform),
      holdNote: holdKeyNote(w.platform),
      holdState: watcher.state,
      holdError: holdOn ? holdWatchLine(watcher.state, w.platform, comboWanted(pref) && st.state === "registered" ? label : "", watcher.detail) : null,
      canOpenPrivacy: holdOn && watcher.state === "untrusted" && !!dictatePrivacyUrl(w.platform),
      state: st.state,
      error: comboWanted(pref) || st.state === "skipped" ? quickEntryStateLine(st) : null,
      available: !why,
      reason: why,
      hint: w.platform === "darwin" && !keystrokesAllowed(false) ? MAC_HINT : null,
    };
  };

  const first = applyAll();
  if (first.state === "taken") w.log(`[desktop] dictate anywhere: ${pref.accelerator} is taken by another app`);

  // The pill's page.
  ipcMain.handle("app:dictateOpened", () => {
    const holding = hold.state === "held";
    const label = holding ? holdKeyLabel(w.platform) ?? "" : acceleratorLabel(pref.accelerator, w.platform);
    return { label, hint: holding ? `let go of ${label} to type it · esc` : `${label} types it · esc`, phase, text: take?.live() ?? "" };
  });
  ipcMain.on("dictate:audio", (event, chunk: unknown) => { if (pill && event.sender === pill.webContents) voice.audio(chunk); });
  ipcMain.on("app:dictateStop", (event) => { if (pill && event.sender === pill.webContents && phase === "listening") finish(); });
  ipcMain.on("app:dictateCancel", () => cancel());
  ipcMain.on("app:dictateMicFailed", (event, why: unknown) => {
    if (!pill || event.sender !== pill.webContents) return;
    cancel();
    notify(typeof why === "string" && why ? why.slice(0, 200) : "The microphone could not be opened.");
  });

  // Settings › General.
  ipcMain.handle("app:dictateGet", () => describe());
  ipcMain.handle("app:dictateSet", async (_event, patch: unknown) => {
    const clash = dictateClash(patch, w.quickEntryAccelerator());
    if (clash) { applyAll(); return { ...(await describe()), ok: false, error: clash }; }
    const turningOn = !!patch && typeof patch === "object" && (patch as { enabled?: unknown }).enabled === true;
    if (turningOn) {
      // ATO-979: no dictation backend here (no helper, an older macOS, no whisper.cpp yet): the switch stays off and says why.
      const why = dictateUnavailableReason(await voice.probe());
      if (why) return { ...(await describe()), ok: false, error: why };
      if (w.platform === "darwin" && !keystrokesAllowed(false)) keystrokesAllowed(true);
    }
    const merged = mergeDictatePref(pref, patch, w.platform);
    if (!merged.ok) { applyAll(); return { ...(await describe()), ok: false, error: merged.error }; }
    // A combo another app holds (or Electron refuses) is not saved: the previous pref goes back in force.
    if (merged.pref.enabled && merged.pref.mode === "toggle") {
      const st = shortcut.apply({ enabled: true, accelerator: merged.pref.accelerator });
      if (st.state === "taken" || st.state === "invalid") {
        applyAll();
        return { ...(await describe()), ok: false, error: quickEntryStateLine(st) ?? SHORTCUT_TAKEN_MESSAGE };
      }
    }
    pref = merged.pref;
    applyAll();
    if (!writeDictatePref(w.userData, pref)) return { ...(await describe()), ok: false, error: "The setting could not be saved." };
    return describe();
  });
  ipcMain.handle("app:dictatePause", (_event, paused: unknown) => {
    if (paused === true) { watcher.stop(); shortcut.pause(); }
    else applyAll();
    return describe();
  });
  ipcMain.handle("app:dictateOpenPrivacy", async () => {
    keystrokesAllowed(true);   // puts Atomic Agent in the Accessibility list
    const url = dictatePrivacyUrl(w.platform);
    if (url) await shell.openExternal(url).catch(() => {});
    return describe();
  });

  return {
    dispose: () => {
      shortcut.dispose();
      watcher.stop();
      if (phase !== "idle") voice.cancel();
      voice.kill();
      reset();
    },
  };
}
