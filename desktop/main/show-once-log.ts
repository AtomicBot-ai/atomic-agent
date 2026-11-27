/**
 * ATO-2401 "Show once": the person clicks Record, does a routine once in a
 * native macOS app, and the steps become a skill draft. This file is the
 * pure half: it folds the raw clicks and keys (uiohook-napi, plus which app
 * and which control was under them, show-once-probe.ts) into a short step
 * log. show-once-skill.ts turns the log into a SKILL.md.
 *
 * What is never kept, whatever the app:
 *  - the characters typed. A run of typing is one "text" step with no
 *    characters and no count, so the skill says "type the text here" and the
 *    agent asks for it on replay. Shortcuts (cmd+s) and action keys
 *    (return, tab, arrows) are kept, they carry no content;
 *  - anything in a protected app (the agent itself, settings, password
 *    managers, the login and security prompts, script runners): one
 *    "protected" step names the app, nothing else of it is kept;
 *  - control labels inside web browsers (page content, which a page writes).
 *
 * The protected list follows the agent's screen guard
 * (src/tools/os/screen/screen-protected.ts BLOCKED_BUNDLE_IDS; the desktop
 * test checks that every id there is here too) plus a name check for
 * password managers that list does not name.
 *
 * Precedent: Codex Record & Replay (ChatGPT desktop, macOS) and Claude in
 * Chrome "Record a workflow" both record clicks and keys into steps and
 * leave secrets out.
 */

export interface ShowOnceApp {
  name: string | null;
  bundleId: string | null;
  pid: number | null;
}

/** The control under the pointer or with the focus, as Accessibility names it. */
export interface ShowOnceElement {
  role: string;
  label: string;
}

export interface ShowOnceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ShowOnceEvent =
  | { kind: "click"; at: number; x: number; y: number; button: "left" | "right"; clicks: number; app: ShowOnceApp | null; window?: ShowOnceRect | null; element?: ShowOnceElement | null }
  | { kind: "key"; at: number; keycode: number; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean; app: ShowOnceApp | null; focused?: ShowOnceElement | null };

export type ShowOnceStep =
  | { kind: "app"; app: string; bundleId: string; browser: boolean }
  | { kind: "click"; app: string; bundleId: string; button: "left" | "right"; double: boolean; element: ShowOnceElement | null; offset: { x: number; y: number } | null }
  | { kind: "keys"; app: string; bundleId: string; keys: string }
  | { kind: "text"; app: string; bundleId: string; secure: boolean }
  | { kind: "protected"; app: string };

export const SHOW_ONCE_LIMITS = {
  /** Steps in one recording; past it the recording stops taking events. */
  maxSteps: 200,
  /** A recording stops on its own after this long (ms). */
  maxDurationMs: 10 * 60_000,
  /** Two clicks this close (ms) at the same spot are one double click. */
  doubleClickMs: 500,
  /** Characters of a control label kept. */
  maxLabelChars: 60,
} as const;

/** No input of any kind recorded (src/tools/os/screen/screen-protected.ts BLOCKED_BUNDLE_IDS). */
export const SHOW_ONCE_PROTECTED_BUNDLE_IDS: readonly string[] = [
  "io.atomicagent.desktop",
  "com.apple.systempreferences",
  "com.apple.Settings",
  "com.apple.keychainaccess",
  "com.apple.SecurityAgent",
  "com.apple.loginwindow",
  "com.apple.Passwords",
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.bitwarden.desktop",
  "com.apple.ScriptEditor2",
  "com.apple.Automator",
  "com.apple.shortcuts",
  "org.hammerspoon.Hammerspoon",
  "com.stairways.keyboardmaestro",
  "com.runningwithcrayons.Alfred",
  "com.runningwithcrayons.Alfred-Preferences",
  "com.raycast.macos",
  "at.obdev.LaunchBar",
];

/** Password managers the id list may not name, matched on the app's name. */
const PROTECTED_NAME_RE = /password|1password|bitwarden|keychain|lastpass|dashlane|keepass|enpass|proton pass|authenticator/i;

/** Browsers: steps are kept, control labels are not (the page wrote them). */
const BROWSER_BUNDLE_PREFIXES: readonly string[] = [
  "com.apple.safari", "com.google.chrome", "org.chromium.chromium", "company.thebrowser", "com.microsoft.edgemac",
  "org.mozilla.", "com.brave.browser", "com.operasoftware.", "com.vivaldi.vivaldi", "com.kagi.kagimacos",
  "com.duckduckgo.macos.browser", "app.zen-browser.zen", "org.torproject.torbrowser", "ru.yandex.desktop.yandex-browser",
  "ai.perplexity.comet", "com.openai.atlas",
];

export type ShowOnceAppClass = "own" | "protected" | "browser" | "open" | "unknown";

function idMatches(list: readonly string[], lower: string): boolean {
  return list.some((id) => {
    const e = id.toLowerCase();
    return lower === e || lower.startsWith(`${e}.`);
  });
}

export function showOnceAppClass(app: ShowOnceApp | null, ownPid: number): ShowOnceAppClass {
  if (!app) return "unknown";
  if (app.pid !== null && app.pid === ownPid) return "own";
  if (!app.bundleId) return "unknown";
  const lower = app.bundleId.toLowerCase();
  if (lower === "io.atomicagent.desktop") return "own";
  if (idMatches(SHOW_ONCE_PROTECTED_BUNDLE_IDS, lower) || PROTECTED_NAME_RE.test(app.name || "")) return "protected";
  if (BROWSER_BUNDLE_PREFIXES.some((p) => lower.startsWith(p))) return "browser";
  return "open";
}

/** uiohook-napi key codes (libuiohook VC_*) that are modifiers alone. */
const MODIFIER_CODES = new Set([42, 54, 29, 3613, 56, 3640, 3675, 3676, 58]);

/** Keys that type a character (or erase one): their runs become one "text" step. */
const TEXT_KEYS: Readonly<Record<number, string>> = {
  16: "q", 17: "w", 18: "e", 19: "r", 20: "t", 21: "y", 22: "u", 23: "i", 24: "o", 25: "p",
  30: "a", 31: "s", 32: "d", 33: "f", 34: "g", 35: "h", 36: "j", 37: "k", 38: "l",
  44: "z", 45: "x", 46: "c", 47: "v", 48: "b", 49: "n", 50: "m",
  2: "1", 3: "2", 4: "3", 5: "4", 6: "5", 7: "6", 8: "7", 9: "8", 10: "9", 11: "0",
  12: "-", 13: "=", 26: "[", 27: "]", 39: ";", 40: "'", 41: "`", 43: "\\", 51: ",", 52: ".", 53: "/",
  57: "space", 14: "backspace",
};

/** Keys that act rather than type, named the way os.screen.key reads them (src/tools/os/screen/screen-keys.ts). */
const ACTION_KEYS: Readonly<Record<number, string>> = {
  1: "escape", 15: "tab", 28: "return", 3612: "return",
  59: "f1", 60: "f2", 61: "f3", 62: "f4", 63: "f5", 64: "f6", 65: "f7", 66: "f8", 67: "f9", 68: "f10", 87: "f11", 88: "f12",
  3655: "home", 3663: "end", 3657: "pageup", 3665: "pagedown", 3667: "forwarddelete",
  57416: "up", 57424: "down", 57419: "left", 57421: "right",
};

export type KeyKind = { kind: "ignore" } | { kind: "text" } | { kind: "keys"; keys: string };

/** What one keydown is: nothing (a modifier alone), typing, or a chord to keep. */
export function classifyKey(e: { keycode: number; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }): KeyKind {
  if (MODIFIER_CODES.has(e.keycode)) return { kind: "ignore" };
  const text = TEXT_KEYS[e.keycode];
  const action = ACTION_KEYS[e.keycode];
  const mods = [e.ctrl ? "ctrl" : "", e.alt ? "alt" : "", e.shift ? "shift" : "", e.meta ? "cmd" : ""].filter(Boolean);
  // App and space switching, Spotlight and launchers, Force Quit: the agent's screen guard refuses
  // these chords (refusedChordReason in screen-protected.ts), so a replay could not press them anyway.
  if ((e.meta && (e.keycode === 15 || e.keycode === 41 || e.keycode === 57)) || ((e.ctrl || e.alt) && e.keycode === 57)
    || (e.ctrl && action !== undefined && ["up", "down", "left", "right"].includes(action)) || (e.meta && e.alt && e.keycode === 1)) {
    return { kind: "ignore" };
  }
  if (e.meta || e.ctrl) {
    const key = text ?? action;
    // A chord on a key this table does not know is left out rather than guessed.
    return key ? { kind: "keys", keys: [...mods, key].join("+") } : { kind: "ignore" };
  }
  if (action) return { kind: "keys", keys: [...mods, action].join("+") };
  if (text) return { kind: "text" };
  return { kind: "ignore" };
}

/** Control roles whose label names the control (a button's title), not the person's content. */
const LABELLED_ROLES = new Set([
  "AXButton", "AXMenuItem", "AXMenuBarItem", "AXMenuButton", "AXPopUpButton", "AXCheckBox", "AXRadioButton",
  "AXTab", "AXTextField", "AXSearchField", "AXComboBox", "AXDisclosureTriangle", "AXSlider", "AXIncrementor",
]);

/** A label safe to write into a skill: a control's own name, one line, short, no markup. */
export function cleanLabel(raw: string): string {
  const s = String(raw || "").replace(/[\u0000-\u001f\u007f`*_#<>|[\]]/g, " ").replace(/"/g, "'").replace(/\s+/g, " ").trim();
  return s.length > SHOW_ONCE_LIMITS.maxLabelChars ? `${s.slice(0, SHOW_ONCE_LIMITS.maxLabelChars - 1).trimEnd()}…` : s;
}

function keptElement(el: ShowOnceElement | null | undefined, browser: boolean): ShowOnceElement | null {
  if (!el || typeof el.role !== "string" || !/^AX[A-Za-z]{1,40}$/.test(el.role)) return null;
  if (el.role === "AXSecureTextField") return { role: el.role, label: "" };
  const label = !browser && LABELLED_ROLES.has(el.role) ? cleanLabel(el.label) : "";
  return { role: el.role, label };
}

const appName = (app: ShowOnceApp) => cleanLabel(app.name || "") || (app.bundleId as string);

/** The step log of one recording. `add` answers whether the log changed. */
export class ShowOnceLog {
  readonly steps: ShowOnceStep[] = [];
  /** Events left out because the app could not be named. */
  skipped = 0;
  full = false;
  private bundle: string | null = null;
  private lastClick: { at: number; x: number; y: number } | null = null;

  constructor(private readonly ownPid: number) {}

  add(e: ShowOnceEvent): boolean {
    if (this.full) return false;
    const cls = showOnceAppClass(e.app, this.ownPid);
    if (cls === "own") return false;
    if (cls === "unknown" || !e.app) {
      this.skipped++;
      return false;
    }
    const app = e.app;
    const bundleId = app.bundleId as string;
    const name = appName(app);
    if (cls === "protected") {
      const last = this.steps[this.steps.length - 1];
      this.bundle = bundleId;
      this.lastClick = null;
      if (last && last.kind === "protected" && last.app === name) return false;
      return this.push({ kind: "protected", app: name });
    }
    const browser = cls === "browser";
    let changed = false;
    if (this.bundle !== bundleId) {
      this.bundle = bundleId;
      this.lastClick = null;
      changed = this.push({ kind: "app", app: name, bundleId, browser });
      if (this.full) return changed;
    }
    if (e.kind === "click") return this.click(e, name, bundleId, browser) || changed;
    return this.key(e, name, bundleId) || changed;
  }

  private click(e: Extract<ShowOnceEvent, { kind: "click" }>, app: string, bundleId: string, browser: boolean): boolean {
    const last = this.steps[this.steps.length - 1];
    const prev = this.lastClick;
    this.lastClick = { at: e.at, x: e.x, y: e.y };
    if (e.clicks >= 2 && last && last.kind === "click" && last.bundleId === bundleId && prev
      && e.at - prev.at <= SHOW_ONCE_LIMITS.doubleClickMs && Math.abs(e.x - prev.x) <= 4 && Math.abs(e.y - prev.y) <= 4) {
      if (last.double) return false;
      last.double = true;
      return true;
    }
    const w = e.window;
    const offset = w && e.x >= w.x && e.y >= w.y && e.x <= w.x + w.width && e.y <= w.y + w.height
      ? { x: Math.round(e.x - w.x), y: Math.round(e.y - w.y) } : null;
    return this.push({ kind: "click", app, bundleId, button: e.button, double: e.clicks >= 2, element: keptElement(e.element, browser), offset });
  }

  private key(e: Extract<ShowOnceEvent, { kind: "key" }>, app: string, bundleId: string): boolean {
    const k = classifyKey(e);
    if (k.kind === "ignore") return false;
    const secure = !!e.focused && e.focused.role === "AXSecureTextField";
    const last = this.steps[this.steps.length - 1];
    // Nothing of a password field is kept: not the keys, not a chord, not how many.
    if (k.kind === "text" || secure) {
      if (last && last.kind === "text" && last.bundleId === bundleId && last.secure === secure) return false;
      return this.push({ kind: "text", app, bundleId, secure });
    }
    return this.push({ kind: "keys", app, bundleId, keys: k.keys });
  }

  private push(step: ShowOnceStep): boolean {
    if (this.steps.length >= SHOW_ONCE_LIMITS.maxSteps) {
      this.full = true;
      return false;
    }
    this.steps.push(step);
    if (this.steps.length >= SHOW_ONCE_LIMITS.maxSteps) this.full = true;
    return true;
  }

  /** Steps a person did (app switches and protected stretches not counted). */
  get actionCount(): number {
    return this.steps.filter((s) => s.kind === "click" || s.kind === "keys" || s.kind === "text").length;
  }

  /** The app of the last kept step, for the indicator. */
  get currentApp(): string | null {
    const last = this.steps[this.steps.length - 1];
    return last ? last.app : null;
  }
}
