import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ATO-523: a global hotkey that opens a small one-line box over whatever app
 * is in front. Enter sends the text into a NEW chat in the main window, the
 * same way a message typed there goes; Esc hides the box.
 *
 * This module is the pure half (no Electron import, so the node tests load
 * it as is): the accelerator check, the saved preference, the register /
 * unregister bookkeeping behind an injected host, and where the box goes on
 * the display under the cursor. quick-entry-window.ts is the Electron half.
 *
 * The preference lives in its own file, `<userData>/quick-entry.json`, for
 * the reason workspace.json does (workspace-pref.ts): prefs.json's writer
 * keeps only the sidebar's keys, and the agent's config.json is shared with
 * the terminal, which has no global hotkey.
 */

export const QUICK_ENTRY_DEFAULT_ACCELERATOR = "CommandOrControl+Shift+Space";

/** The box's size in DIP (points on macOS). */
export const QUICK_ENTRY_SIZE = { width: 640, height: 64 } as const;

export interface QuickEntryPref {
  enabled: boolean;
  accelerator: string;
}

export const QUICK_ENTRY_DEFAULT_PREF: QuickEntryPref = {
  enabled: true,
  accelerator: QUICK_ENTRY_DEFAULT_ACCELERATOR,
};

/* ---------------- accelerator ---------------- */

/** Electron's modifier names, by lower case, to the spelling we store. */
const MODIFIERS: Record<string, string> = {
  commandorcontrol: "CommandOrControl",
  cmdorctrl: "CommandOrControl",
  command: "Command",
  cmd: "Command",
  control: "Control",
  ctrl: "Control",
  alt: "Alt",
  option: "Alt",
  altgr: "AltGr",
  shift: "Shift",
  super: "Super",
  meta: "Super",
};

/** The order modifiers are written in, so one combo has one spelling. */
const MODIFIER_ORDER = ["CommandOrControl", "Command", "Control", "Alt", "AltGr", "Shift", "Super"];

/** Named keys Electron's accelerator grammar takes, by lower case. */
const NAMED_KEYS: Record<string, string> = {
  space: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  return: "Return",
  enter: "Return",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  escape: "Escape",
  esc: "Escape",
  plus: "Plus",
  printscreen: "PrintScreen",
};

/** Punctuation keys, written as themselves ("Plus" stands for "+"). */
const PUNCTUATION = new Set(["-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "`", ")", "!", "@", "#", "$", "%", "^", "&", "*", "(", ":", "<", "_", ">", "?", "~", "{", "|", "}", '"']);

function normalizeKey(raw: string): string | null {
  if (raw.length === 1) {
    if (/^[a-z0-9]$/i.test(raw)) return raw.toUpperCase();
    return PUNCTUATION.has(raw) ? raw : null;
  }
  const low = raw.toLowerCase();
  if (NAMED_KEYS[low]) return NAMED_KEYS[low];
  const f = /^f([1-9]|1[0-9]|2[0-4])$/.exec(low);
  if (f) return "F" + f[1];
  const num = /^num([0-9])$/.exec(low);
  if (num) return "num" + num[1];
  if (["numdec", "numadd", "numsub", "nummult", "numdiv"].includes(low)) return low;
  return null;
}

export type AcceleratorCheck =
  | { ok: true; accelerator: string }
  | { ok: false; error: string };

/**
 * Checks a combo against Electron's accelerator grammar and writes it one
 * way. A global hotkey takes the keys from every app, so it needs a real
 * modifier (Command, Control, Alt or Super); Shift alone would take a
 * capital letter from every text field. Exactly one key.
 */
export function normalizeAccelerator(raw: unknown): AcceleratorCheck {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "Press a key combination." };
  const text = raw.trim();
  /* "+" separates parts, and a trailing "+" is the key itself ("Ctrl++"). */
  const parts = text.endsWith("++") ? [...text.slice(0, -2).split("+"), "Plus"] : text.split("+");
  const mods = new Set<string>();
  let key: string | null = null;
  for (const part of parts.map((p) => p.trim())) {
    if (!part) return { ok: false, error: "That combination is not complete." };
    const mod = MODIFIERS[part.toLowerCase()];
    if (mod) {
      mods.add(mod);
      continue;
    }
    const k = normalizeKey(part);
    if (!k) return { ok: false, error: `“${part}” cannot be part of a shortcut.` };
    if (key) return { ok: false, error: "A shortcut has one key besides the modifiers." };
    key = k;
  }
  if (!key) return { ok: false, error: "Add a key to the modifiers, like Space." };
  /* CommandOrControl already is Command on a Mac and Control elsewhere. */
  if (mods.has("CommandOrControl") && (mods.has("Command") || mods.has("Control"))) {
    return { ok: false, error: "Command or Control appears twice." };
  }
  const real = [...mods].some((m) => m !== "Shift");
  if (!real) return { ok: false, error: "Add Command, Control, Option/Alt or the Windows key: a shortcut for every app needs one." };
  const ordered = MODIFIER_ORDER.filter((m) => mods.has(m));
  return { ok: true, accelerator: [...ordered, key].join("+") };
}

/** How a combo is shown: "⌘⇧Space" on a Mac, "Ctrl+Shift+Space" elsewhere. */
export function acceleratorLabel(accelerator: string, platform: NodeJS.Platform | string): string {
  const parts = accelerator.split("+").filter(Boolean);
  if (accelerator.endsWith("++")) parts.push("+");
  const mac = platform === "darwin";
  const MAC: Record<string, string> = {
    CommandOrControl: "⌘", Command: "⌘", Control: "⌃", Alt: "⌥", AltGr: "⌥", Shift: "⇧", Super: "⌘",
    Return: "↩", Backspace: "⌫", Delete: "⌦", Escape: "⎋", Tab: "⇥",
    Up: "↑", Down: "↓", Left: "←", Right: "→", Plus: "+",
  };
  const OTHER: Record<string, string> = {
    CommandOrControl: "Ctrl", Command: "Win", Control: "Ctrl", Alt: "Alt", AltGr: "AltGr", Shift: "Shift", Super: "Win",
    Return: "Enter", Escape: "Esc", Plus: "+",
  };
  const map = mac ? MAC : OTHER;
  const shown = parts.map((p) => map[p] ?? p);
  return mac ? shown.join("") : shown.join("+");
}

/* ---------------- preference file ---------------- */

export function quickEntryPrefPath(userData: string): string {
  return join(userData, "quick-entry.json");
}

/** A quick-entry.json body, with the defaults for anything missing or wrong. Does not touch the disk. */
export function parseQuickEntryPref(text: string | null): QuickEntryPref {
  if (text === null) return { ...QUICK_ENTRY_DEFAULT_PREF };
  try {
    const raw = JSON.parse(text) as { enabled?: unknown; accelerator?: unknown } | null;
    if (!raw || typeof raw !== "object") return { ...QUICK_ENTRY_DEFAULT_PREF };
    const acc = normalizeAccelerator(raw.accelerator);
    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : QUICK_ENTRY_DEFAULT_PREF.enabled,
      accelerator: acc.ok ? acc.accelerator : QUICK_ENTRY_DEFAULT_ACCELERATOR,
    };
  } catch {
    return { ...QUICK_ENTRY_DEFAULT_PREF };
  }
}

export function readQuickEntryPref(userData: string): QuickEntryPref {
  let text: string | null = null;
  try {
    text = readFileSync(quickEntryPrefPath(userData), "utf8");
  } catch {
    text = null;
  }
  return parseQuickEntryPref(text);
}

/** Written whole, via a temp file. Best effort, never throws. */
export function writeQuickEntryPref(userData: string, pref: QuickEntryPref): boolean {
  const path = quickEntryPrefPath(userData);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ enabled: pref.enabled, accelerator: pref.accelerator }) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** A Settings write ({enabled?, accelerator?}) on top of the saved pref, checked. */
export function mergeQuickEntryPref(
  current: QuickEntryPref,
  patch: unknown,
): { ok: true; pref: QuickEntryPref } | { ok: false; error: string } {
  if (!patch || typeof patch !== "object") return { ok: false, error: "Nothing to change." };
  const p = patch as { enabled?: unknown; accelerator?: unknown };
  const next: QuickEntryPref = { ...current };
  if (p.enabled !== undefined) {
    if (typeof p.enabled !== "boolean") return { ok: false, error: "enabled must be true or false." };
    next.enabled = p.enabled;
  }
  if (p.accelerator !== undefined) {
    const acc = normalizeAccelerator(p.accelerator);
    if (!acc.ok) return acc;
    next.accelerator = acc.accelerator;
  }
  return { ok: true, pref: next };
}

/* ---------------- registration ---------------- */

/** Electron's globalShortcut, as much of it as this needs. */
export interface ShortcutHost {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  isRegistered(accelerator: string): boolean;
}

export type QuickEntryState =
  | { state: "off" }
  | { state: "skipped"; reason: string }
  | { state: "registered"; accelerator: string }
  | { state: "taken"; accelerator: string }
  | { state: "invalid"; accelerator: string; error: string };

export const SHORTCUT_TAKEN_MESSAGE = "This shortcut is taken by another app. Choose another one.";

/** Whether this launch may take a global hotkey at all. */
export function quickEntrySkipReason(opts: { smoke: boolean; probe: boolean; modelsTest: boolean; envOff: boolean }): string | null {
  if (opts.smoke) return "smoke run";
  if (opts.probe) return "first-run probe";
  if (opts.modelsTest) return "models test run";
  if (opts.envOff) return "ATOMIC_AGENT_NO_GLOBAL_SHORTCUT is set";
  return null;
}

/**
 * Holds the one hotkey this app registers and nothing else: never
 * `unregisterAll`, which would also drop the Esc the screen marks overlay
 * takes while it shows (screen-overlay-window.ts).
 */
export class QuickEntryShortcut {
  private held: string | null = null;
  private last: QuickEntryState = { state: "off" };

  constructor(
    private readonly host: ShortcutHost,
    private readonly onPress: () => void,
    private readonly skipReason: string | null = null,
  ) {}

  /** Puts the saved pref in force: lets go of the old combo, then takes the new one. */
  apply(pref: QuickEntryPref): QuickEntryState {
    this.release();
    if (this.skipReason) return (this.last = { state: "skipped", reason: this.skipReason });
    if (!pref.enabled) return (this.last = { state: "off" });
    const acc = normalizeAccelerator(pref.accelerator);
    if (!acc.ok) return (this.last = { state: "invalid", accelerator: String(pref.accelerator), error: acc.error });
    /* Electron answers isRegistered only for this app; true here is a combo
       something else of ours holds (the marks overlay's Esc cannot be one:
       Esc alone does not pass the check above). */
    if (this.host.isRegistered(acc.accelerator)) return (this.last = { state: "taken", accelerator: acc.accelerator });
    let ok = false;
    try {
      ok = this.host.register(acc.accelerator, this.onPress);
    } catch (err) {
      return (this.last = { state: "invalid", accelerator: acc.accelerator, error: err instanceof Error ? err.message : String(err) });
    }
    if (!ok) return (this.last = { state: "taken", accelerator: acc.accelerator });
    this.held = acc.accelerator;
    return (this.last = { state: "registered", accelerator: acc.accelerator });
  }

  /** Lets go of the combo while Settings records a new one, so pressing the old one does not open the box. */
  pause(): void {
    this.release();
  }

  /** The quit: lets go of the combo. */
  dispose(): void {
    this.release();
    this.last = { state: "off" };
  }

  state(): QuickEntryState {
    return this.last;
  }

  private release(): void {
    if (!this.held) return;
    try {
      this.host.unregister(this.held);
    } catch {
      /* already gone */
    }
    this.held = null;
  }
}

/** What Settings shows for a state: a line under the row, or nothing. */
export function quickEntryStateLine(st: QuickEntryState): string | null {
  if (st.state === "taken") return SHORTCUT_TAKEN_MESSAGE;
  if (st.state === "invalid") return `This shortcut cannot be used: ${st.error}`;
  if (st.state === "skipped") return `The shortcut is off for this launch (${st.reason}).`;
  return null;
}

/* ---------------- placement ---------------- */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface QuickEntryDisplay {
  bounds: Rect;
  workArea: Rect;
}

function contains(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

function distance2(r: Rect, p: { x: number; y: number }): number {
  const dx = p.x < r.x ? r.x - p.x : p.x >= r.x + r.width ? p.x - (r.x + r.width - 1) : 0;
  const dy = p.y < r.y ? r.y - p.y : p.y >= r.y + r.height ? p.y - (r.y + r.height - 1) : 0;
  return dx * dx + dy * dy;
}

/** The display the cursor is on, or the nearest one (a cursor in a gap between screens). */
export function displayUnderCursor<D extends QuickEntryDisplay>(cursor: { x: number; y: number }, displays: D[]): D | null {
  if (!displays.length) return null;
  const hit = displays.find((d) => contains(d.bounds, cursor));
  if (hit) return hit;
  let best = displays[0]!;
  for (const d of displays) if (distance2(d.bounds, cursor) < distance2(best.bounds, cursor)) best = d;
  return best;
}

/**
 * Where the box opens: centred across the work area of the display under
 * the cursor, a fifth of the way down (where Spotlight sits), narrower than
 * a small screen and never past its edges. Whole numbers: Electron rounds
 * fractional bounds differently per platform.
 */
export function quickEntryBounds(
  cursor: { x: number; y: number },
  displays: QuickEntryDisplay[],
  size: { width: number; height: number } = QUICK_ENTRY_SIZE,
): Rect {
  const d = displayUnderCursor(cursor, displays);
  const area = d ? d.workArea : { x: 0, y: 0, width: size.width, height: size.height };
  const width = Math.max(1, Math.min(size.width, area.width - 32));
  const height = Math.max(1, Math.min(size.height, area.height));
  const x = Math.round(area.x + (area.width - width) / 2);
  const y = Math.round(area.y + Math.max(0, Math.min(area.height - height, Math.round(area.height / 5))));
  return { x, y, width: Math.round(width), height: Math.round(height) };
}

/** The always-on-top level: macOS 'floating' (over normal windows, under menus); elsewhere 'screen-saver'. */
export function quickEntryWindowLevel(platform: NodeJS.Platform | string): "floating" | "screen-saver" {
  return platform === "darwin" ? "floating" : "screen-saver";
}

/** The text Enter sends: trimmed, at most 20 000 characters; null for nothing. */
export function quickEntryText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  return text.length > 20_000 ? text.slice(0, 20_000) : text;
}
