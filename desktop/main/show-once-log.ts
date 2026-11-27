import { SHOW_ONCE_MAX_LABEL, cleanLabel, classifyKey, keptElement, showOnceAppClass } from "./show-once-classify.js";

export {
  SHOW_ONCE_PROTECTED_BUNDLE_IDS,
  classifyKey,
  cleanLabel,
  showOnceAppClass,
  type KeyKind,
  type ShowOnceAppClass,
} from "./show-once-classify.js";

/**
 * ATO-2401 "Show once": the person clicks Record, does a routine once in a
 * native app, and the steps become a skill draft. This file is the pure
 * half: it folds the raw clicks and keys (uiohook-napi, plus which app,
 * window and control was under them, show-once-prober.ts) into a short
 * step log. show-once-skill.ts turns the log into a SKILL.md.
 *
 * What is never kept, whatever the app:
 *  - the characters typed. A run of typing is one "text" step with no
 *    characters and no count, so the skill says "type the text here" and the
 *    agent asks for it on replay. Shortcuts (cmd+s) and action keys
 *    (return, tab, arrows) are kept, they carry no content;
 *  - anything in a protected app (the agent itself, settings, password
 *    managers, the login and security prompts, script runners): one
 *    "protected" step names the app, nothing else of it is kept;
 *  - control labels, window titles and menu paths inside web browsers
 *    (page content, which a page writes).
 *
 * ATO-2499: with the Accessibility helper (native/atomic-show-once.swift)
 * the log also gets menu commands ("menu" events: File > Export > PDF,
 * which replace the clicks that opened the menu, or name the menu item a
 * shortcut ran) and window titles. Each step keeps the title of the window
 * it happened in (`window`) and the one in front after it (`after`, when
 * that changed): the replay check compares those (show-once-skill.ts).
 *
 * The protected list follows the agent's screen guard
 * (src/tools/os/screen/screen-protected.ts BLOCKED_BUNDLE_IDS; the desktop
 * test checks that every id there is here too) plus a name check for
 * password managers that list does not name (show-once-classify.ts).
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
  | { kind: "click"; at: number; x: number; y: number; button: "left" | "right"; clicks: number; app: ShowOnceApp | null; window?: ShowOnceRect | null; element?: ShowOnceElement | null; windowTitle?: string | null }
  | { kind: "key"; at: number; keycode: number; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean; app: ShowOnceApp | null; focused?: ShowOnceElement | null; windowTitle?: string | null }
  | { kind: "menu"; at: number; app: ShowOnceApp | null; path: string[] }
  | { kind: "window"; at: number; app: ShowOnceApp | null; title: string };

/** Where a step happened and what was in front after it (titles, cleaned). */
interface Seen { window?: string; after?: string }

export type ShowOnceStep =
  | { kind: "app"; app: string; bundleId: string; browser: boolean }
  | ({ kind: "click"; app: string; bundleId: string; button: "left" | "right"; double: boolean; element: ShowOnceElement | null; offset: { x: number; y: number } | null } & Seen)
  | ({ kind: "keys"; app: string; bundleId: string; keys: string; menu?: string[] } & Seen)
  | ({ kind: "text"; app: string; bundleId: string; secure: boolean; into?: string } & Seen)
  | ({ kind: "menu"; app: string; bundleId: string; path: string[] } & Seen)
  | { kind: "protected"; app: string };

export type ShowOnceActionStep = Extract<ShowOnceStep, { kind: "click" | "keys" | "text" | "menu" }>;

export const SHOW_ONCE_LIMITS = {
  /** Steps in one recording; past it the recording stops taking events. */
  maxSteps: 200,
  /** A recording stops on its own after this long (ms). */
  maxDurationMs: 10 * 60_000,
  /** Two clicks this close (ms) at the same spot are one double click. */
  doubleClickMs: 500,
  /** Characters of a control label kept. */
  maxLabelChars: SHOW_ONCE_MAX_LABEL,
  /** A menu command this soon (ms) after a shortcut is the item that shortcut ran. */
  shortcutMenuMs: 1000,
  /** Levels of a menu path kept (File > Export To > PDF). */
  maxMenuDepth: 6,
} as const;

/** Clicks that only open or walk a menu: a "menu" step that follows replaces them. */
const MENU_ROLES = new Set(["AXMenuBarItem", "AXMenuItem", "AXMenu", "AXMenuBar"]);

const appName = (app: ShowOnceApp) => cleanLabel(app.name || "") || (app.bundleId as string);

/** A step a person did (not an app switch, not a protected stretch). */
export const isShowOnceAction = (s: ShowOnceStep | undefined): s is ShowOnceActionStep =>
  !!s && (s.kind === "click" || s.kind === "keys" || s.kind === "text" || s.kind === "menu");

/** The step log of one recording. `add` answers whether the log changed. */
export class ShowOnceLog {
  readonly steps: ShowOnceStep[] = [];
  /** Events left out because the app could not be named. */
  skipped = 0;
  full = false;
  private bundle: string | null = null;
  private browser = false;
  private lastClick: { at: number; x: number; y: number } | null = null;
  private lastAt = 0;

  /** ATO-2499 `platform`: how keys are read (classifyKey); the Mac when not given. */
  constructor(private readonly ownPid: number, private readonly platform: string = "darwin") {}

  add(e: ShowOnceEvent): boolean {
    if (this.full) return false;
    const cls = showOnceAppClass(e.app, this.ownPid);
    if (cls === "own") return false;
    if (cls === "unknown" || !e.app) {
      if (e.kind === "click" || e.kind === "key") this.skipped++;
      return false;
    }
    const app = e.app;
    const bundleId = app.bundleId as string;
    const name = appName(app);
    // A title or a menu path only adds to what a person did; on its own it is no step.
    if (e.kind === "window") return cls === "open" && bundleId === this.bundle ? this.seen(bundleId, e.title, true) : false;
    if (e.kind === "menu") return cls === "open" && bundleId === this.bundle ? this.menu(e, name, bundleId) : false;
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
      this.browser = browser;
      this.lastClick = null;
      changed = this.push({ kind: "app", app: name, bundleId, browser });
      if (this.full) return changed;
    }
    const title = browser ? "" : cleanLabel(e.windowTitle || "");
    // The title in front now is the previous step's after-state.
    if (title) changed = this.seen(bundleId, title, false) || changed;
    const before = this.steps.length;
    const did = e.kind === "click" ? this.click(e, name, bundleId, browser) : this.key(e, name, bundleId, browser);
    if (did) {
      this.lastAt = e.at;
      const last = this.steps[this.steps.length - 1];
      if (title && this.steps.length > before && isShowOnceAction(last) && last.window === undefined) last.window = title;
    }
    return did || changed;
  }

  /**
   * The window in front of `bundleId` is now `raw`: the last step's
   * after-state when it moved. `event`: a pushed title (a window event),
   * which also names where a step without a title happened.
   */
  private seen(bundleId: string, raw: string, event: boolean): boolean {
    const title = this.browser ? "" : cleanLabel(raw);
    const last = this.steps[this.steps.length - 1];
    if (!title || !isShowOnceAction(last) || last.bundleId !== bundleId) return false;
    if (last.window === title) {
      if (last.after === undefined) return false;
      delete last.after;
      return true;
    }
    if (last.window === undefined) {
      if (!event) return false;
      last.window = title;
      return true;
    }
    if (last.after === title) return false;
    last.after = title;
    return true;
  }

  private menu(e: Extract<ShowOnceEvent, { kind: "menu" }>, app: string, bundleId: string): boolean {
    const path = (Array.isArray(e.path) ? e.path : []).map((p) => cleanLabel(String(p))).filter(Boolean).slice(-SHOW_ONCE_LIMITS.maxMenuDepth);
    if (path.length === 0) return false;
    const last = this.steps[this.steps.length - 1];
    if (last && last.kind === "keys" && last.bundleId === bundleId && /(?:^|\+)(?:cmd|ctrl)\+/.test(last.keys)
      && e.at - this.lastAt <= SHOW_ONCE_LIMITS.shortcutMenuMs) {
      if (last.menu) return false;
      last.menu = path;
      return true;
    }
    // The clicks on the menu bar and down the menu are this one command.
    let window: string | undefined;
    for (let s = this.steps[this.steps.length - 1]; s && s.kind === "click" && s.bundleId === bundleId && s.element && MENU_ROLES.has(s.element.role); s = this.steps[this.steps.length - 1]) {
      window = s.window ?? window;
      this.steps.pop();
      this.full = false;
    }
    this.lastClick = null;
    this.lastAt = e.at;
    const step: ShowOnceStep = { kind: "menu", app, bundleId, path };
    if (window) step.window = window;
    this.push(step);
    return true;
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

  private key(e: Extract<ShowOnceEvent, { kind: "key" }>, app: string, bundleId: string, browser: boolean): boolean {
    const k = classifyKey(e, this.platform);
    if (k.kind === "ignore") return false;
    const secure = !!e.focused && e.focused.role === "AXSecureTextField";
    const last = this.steps[this.steps.length - 1];
    // Nothing of a password field is kept: not the keys, not a chord, not how many.
    if (k.kind === "text" || secure) {
      if (last && last.kind === "text" && last.bundleId === bundleId && last.secure === secure) return false;
      const step: ShowOnceStep = { kind: "text", app, bundleId, secure };
      const into = secure ? null : keptElement(e.focused, browser);
      if (into && into.label) step.into = into.label;
      return this.push(step);
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
    return this.steps.filter(isShowOnceAction).length;
  }

  /** The app of the last kept step, for the indicator. */
  get currentApp(): string | null {
    const last = this.steps[this.steps.length - 1];
    return last ? last.app : null;
  }
}
