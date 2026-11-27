import { app, globalShortcut, ipcMain, shell, systemPreferences } from "electron";

import {
  DictateTake,
  dictateClash,
  dictateFinishTimeoutMs,
  dictateUnavailableReason,
  mergeDictatePref,
  pickDictateLocales,
  readDictatePref,
  writeDictatePref,
  type DictatePref,
} from "./dictate-anywhere.js";
import { dictateFailureView, type DictateFailure } from "./dictate-errors.js";
import { DictatePill } from "./dictate-pill.js";
import { wireDictatePillPage } from "./dictate-pill-ipc.js";
import { dictatePrivacyUrl, holdKeyLabel, holdKeyNote, holdWatchFailed, holdWatchLine, type HoldAction } from "./dictate-hold.js";
import { holdKeyWatch } from "./dictate-hold-watch.js";
import { keystrokesAllowed, pasteIntoFrontApp } from "./keystroke-clipboard-host.js";
import {
  SHORTCUT_TAKEN_MESSAGE,
  acceleratorLabel,
  quickEntrySkipReason,
  quickEntryStateLine,
  QuickEntryShortcut,
} from "./quick-entry.js";
import { VoiceSession } from "./speech.js";

/**
 * The Electron half of ATO-1064 (dictate-anywhere.ts holds the rest).
 *
 * A take has its own VoiceSession, never the composer's (main.ts `voice`):
 * the composer's microphone and this hotkey cannot end each other's take,
 * and speech.ts is only called, not changed. The pill that holds the
 * microphone is dictate-pill.ts, its page's routes dictate-pill-ipc.ts.
 *
 * Two ways in: the hold key (dictate-hold-watch.ts) or the toggle combo
 * (globalShortcut). In the hold mode the combo stands in while the watcher cannot run (no
 * Accessibility yet, a build without the helper), so the switch never
 * turns on to nothing.
 */

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

// The pill's window lives in dictate-pill.ts; main.ts imports the Dock check from here.
export { isDictatePill } from "./dictate-pill.js";

export function wireDictateAnywhere(w: DictateWiring): { dispose: () => void } {
  const voice = new VoiceSession();
  let pref: DictatePref = readDictatePref(w.userData, w.platform);
  let phase: Phase = "idle";
  let take: DictateTake | null = null;
  let finishTimer: NodeJS.Timeout | null = null;
  /** The hold key came up while the take was still starting: finish it as soon as it listens. */
  let finishOnListen = false;
  /* The pill's window (dictate-pill.ts); ATO-2750: it also shows a failure,
     and the system notification is only for when it cannot be shown. */
  const pill = new DictatePill({ platform: w.platform, armed: () => voice.armed, onCancel: () => cancel() });
  const tell = (payload: Record<string, unknown>) => pill.send(payload);
  const closePill = () => {
    if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
    pill.close();
  };
  const reset = () => { closePill(); take = null; phase = "idle"; finishOnListen = false; };

  const cancel = () => {
    if (phase === "idle") { if (pill.failure) closePill(); return; }   // ATO-2750: × on a failure
    voice.cancel();
    reset();
  };

  /** The take's words into the app in front. The pill goes first, so nothing of ours is in the way. */
  const deliver = async (t: DictateTake | null) => {
    reset();
    const text = t?.text() ?? "";
    if (!text) { if (t?.error) fail({ kind: "take-failed" }, t.error); return; }
    const out = await pasteIntoFrontApp(text);
    if (!out.pasted) fail({ kind: "paste", accessibility: w.platform === "darwin" && !keystrokesAllowed(false) }, out.reason);
  };

  const onEvent = (payload: Record<string, unknown>) => {
    if (!take) return;
    const out = take.apply(payload);
    if (out === "continue") { if (phase === "listening") tell({ phase, text: take.live() }); return; }
    if (out === "cancelled") { reset(); return; }
    if (out === "failed") { const err = take.error; voice.cancel(); reset(); if (err) fail({ kind: "take-failed" }, err); return; }
    void deliver(take);
  };

  /** ATO-2750: a failure in the pill, the raw detail in the log (dictate-pill.ts showFailure). */
  const fail = (f: DictateFailure, detail?: string | null) => {
    const view = dictateFailureView(f, w.platform);
    w.log(`[desktop] dictate anywhere: ${view.line}${detail ? ` (${detail})` : ""}`);
    reset();
    pill.showFailure(view);
  };

  const start = async () => {
    if (pill.failure) closePill();   // ATO-2750: a new take replaces the failure line
    phase = "starting";
    const probe = await voice.probe();
    const why = dictateUnavailableReason(probe);
    if (why) { fail({ kind: "unavailable", reason: why }); return; }
    if (w.platform === "darwin" && systemPreferences.getMediaAccessStatus("microphone") !== "granted") {
      const granted = await systemPreferences.askForMediaAccess("microphone").catch(() => false);
      if (!granted) { fail({ kind: "mic-off" }); return; }
    }
    if (phase !== "starting") return;   // disposed meanwhile
    take = new DictateTake();
    const locales = pickDictateLocales(w.locales(), probe.installed, app.getLocale());
    const res = await voice.start(locales, onEvent);
    if (phase !== "starting") { if (res.ok) voice.cancel(); return; }   // cancelled while it started
    if (!res.ok) { fail({ kind: "start-failed" }, res.error); return; }
    phase = "listening";
    pill.show();
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
  // ATO-1064: the hold key and its watcher (dictate-hold-watch.ts).
  const { hold, watcher } = holdKeyWatch(w.platform, w.log, onHold, () => applyCombo());

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
      // ATO-2750: the shortcut mode too, when the paste needs Accessibility (the hint below says so).
      canOpenPrivacy: !!dictatePrivacyUrl(w.platform) && ((holdOn && watcher.state === "untrusted") || (pref.enabled && !keystrokesAllowed(false))),
      state: st.state,
      error: comboWanted(pref) || st.state === "skipped" ? quickEntryStateLine(st) : null,
      available: !why,
      reason: why,
      hint: w.platform === "darwin" && !keystrokesAllowed(false) ? MAC_HINT : null,
    };
  };

  const first = applyAll();
  if (first.state === "taken") w.log(`[desktop] dictate anywhere: ${pref.accelerator} is taken by another app`);

  // The pill's page (dictate-pill-ipc.ts).
  wireDictatePillPage(pill, {
    platform: w.platform,
    opened: () => {
      const holding = hold.state === "held";
      const label = holding ? holdKeyLabel(w.platform) ?? "" : acceleratorLabel(pref.accelerator, w.platform);
      return { label, hint: holding ? `let go of ${label} to type it · esc` : `${label} types it · esc`, phase, text: take?.live() ?? "" };
    },
    audio: (chunk) => voice.audio(chunk),
    stop: () => { if (phase === "listening") finish(); },
    cancel: () => cancel(),
    micFailed: (denied, detail) => { cancel(); fail(denied ? { kind: "mic-off" } : { kind: "mic-failed" }, detail); },
    close: closePill,
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
