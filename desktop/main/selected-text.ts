import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ATO-985: the hotkey's mini chat window takes the text selected in the app in front
 * (Raycast AI Commands, ChatGPT for macOS "Work with apps", PopClip).
 *
 * The pure half: the saved choice and what Settings shows. The choice lives
 * in its own file, `<userData>/selected-text.json`, beside quick-entry.json
 * (quick-entry.ts), whose writer keeps only its own two keys.
 *
 * Unset, it is on only where it works without asking: on macOS once this
 * app is already allowed under Accessibility, which the key press needs.
 * Windows and Linux leave it to the user, as the switch says.
 *
 * The same file keeps the language Translate used last (the mini chat's
 * picker, renderer/mini-chat-selection.js), so the next Translate starts
 * there.
 */

export interface SelectedTextPref {
  /** null: never set, the platform default applies. */
  use: boolean | null;
  /** The language Translate used last ("Spanish"), or null: never picked. */
  translateTo: string | null;
}

/** A language name the picker may save: letters, spaces, brackets and dashes, up to 40 characters. */
export function selectedTextLanguage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return /^[\p{L}][\p{L}\p{M} ()-]{0,39}$/u.test(name) ? name : null;
}

export function selectedTextPrefPath(userData: string): string {
  return join(userData, "selected-text.json");
}

export function parseSelectedTextPref(text: string | null): SelectedTextPref {
  if (text === null) return { use: null, translateTo: null };
  try {
    const raw = JSON.parse(text) as { use?: unknown; translateTo?: unknown } | null;
    if (!raw || typeof raw !== "object") return { use: null, translateTo: null };
    return { use: typeof raw.use === "boolean" ? raw.use : null, translateTo: selectedTextLanguage(raw.translateTo) };
  } catch {
    return { use: null, translateTo: null };
  }
}

export function readSelectedTextPref(userData: string): SelectedTextPref {
  try {
    return parseSelectedTextPref(readFileSync(selectedTextPrefPath(userData), "utf8"));
  } catch {
    return parseSelectedTextPref(null);
  }
}

/** Written whole, via a temp file. Best effort, never throws. */
export function writeSelectedTextPref(userData: string, pref: SelectedTextPref): boolean {
  const path = selectedTextPrefPath(userData);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ use: pref.use, translateTo: pref.translateTo }) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** Whether the hotkey reads the selection now: the saved choice, else the platform default. */
export function selectedTextInUse(pref: SelectedTextPref, platform: NodeJS.Platform | string, trusted: boolean): boolean {
  if (pref.use !== null) return pref.use && (platform !== "darwin" || trusted);
  return platform === "darwin" && trusted;
}

export const SELECTED_TEXT_ACCESSIBILITY_HINT =
  "Needs Accessibility: System Settings › Privacy & Security › Accessibility, then turn on Atomic Agent.";

export interface SelectedTextInfo {
  ok: true;
  /** What the switch shows. */
  on: boolean;
  /** One line under the row, or null. */
  hint: string | null;
  /** The language Translate used last, for the mini chat's picker. */
  translateTo: string | null;
}

/**
 * The Settings row. On macOS a switch turned on without Accessibility shows
 * the hint and reads nothing until the permission is given; the choice is
 * kept, so it starts working once it is.
 */
export function selectedTextInfo(pref: SelectedTextPref, platform: NodeJS.Platform | string, trusted: boolean): SelectedTextInfo {
  const wanted = pref.use ?? (platform === "darwin" && trusted);
  const hint = platform === "darwin" && !trusted ? SELECTED_TEXT_ACCESSIBILITY_HINT : null;
  return { ok: true, on: wanted, hint, translateTo: pref.translateTo };
}

/**
 * A write checked and laid over the saved choice: `use` from Settings,
 * `translateTo` from the mini chat's picker. Either may come alone.
 */
export function mergeSelectedTextPref(
  current: SelectedTextPref,
  patch: unknown,
): { ok: true; pref: SelectedTextPref } | { ok: false; error: string } {
  if (!patch || typeof patch !== "object") return { ok: false, error: "Nothing to change." };
  const p = patch as { use?: unknown; translateTo?: unknown };
  if (!("use" in p) && !("translateTo" in p)) return { ok: false, error: "Nothing to change." };
  const next: SelectedTextPref = { ...current };
  if ("use" in p) {
    if (typeof p.use !== "boolean") return { ok: false, error: "use must be true or false." };
    next.use = p.use;
  }
  if ("translateTo" in p) {
    const lang = selectedTextLanguage(p.translateTo);
    if (!lang) return { ok: false, error: "Not a language name." };
    next.translateTo = lang;
  }
  return { ok: true, pref: next };
}
