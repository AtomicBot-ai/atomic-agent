import type { SourceApp } from "./replace-selection.js";
import { selectedTextSkip, type SelectedTextPref } from "./selected-text.js";

/**
 * ATO-2736: the hotkey's read of the selection, with the reason when there
 * is none, so the mini chat can say why it opened without the text instead
 * of opening empty (Raycast and PopClip say so in one line).
 *
 *   permission  macOS has not allowed Atomic Agent under Accessibility
 *   off         "Use selected text" is off (by the user, or the default off macOS)
 *   failed      the read threw (no tool, a timeout, macOS refused the key press)
 *   empty       nothing was selected
 *
 * Pure: the Electron half (selected-text-ipc.ts) passes the reads in.
 */

export type SelectionMiss = "permission" | "off" | "failed" | "empty";

/** The selection the hotkey read, and (ATO-2268, macOS) the app it came from, for "Replace in …". */
export interface GrabbedSelection {
  text: string;
  app: SourceApp | null;
}

export type SelectionGrab =
  | { selection: GrabbedSelection; miss: null }
  | { selection: null; miss: SelectionMiss };

export interface GrabDeps {
  pref: SelectedTextPref;
  platform: NodeJS.Platform | string;
  trusted: boolean;
  /** Whether "Replace in …" needs the app in front (replaceAvailable). */
  withFrontApp: boolean;
  readText: () => Promise<string | null>;
  readFrontApp: () => Promise<SourceApp | null>;
}

export async function grabSelectionWith(d: GrabDeps): Promise<SelectionGrab> {
  const skip = selectedTextSkip(d.pref, d.platform, d.trusted);
  if (skip) return { selection: null, miss: skip };
  try {
    /* ATO-2268: the app in front is read beside the copy (the copy does not
       change which app is in front), so "Replace in …" knows where to put
       the answer back. It never holds the selection back. */
    const front = d.withFrontApp ? d.readFrontApp().catch(() => null) : Promise.resolve(null);
    const [text, app] = await Promise.all([d.readText(), front]);
    return text ? { selection: { text, app }, miss: null } : { selection: null, miss: "empty" };
  } catch {
    return { selection: null, miss: "failed" };
  }
}

/**
 * The line the mini chat shows for a miss, or null when it shows nothing.
 * Only "permission" and "failed" are worth a line: "off" is the user's
 * choice and "empty" is the hotkey pressed with nothing selected.
 */
export function selectionMissNotice(miss: SelectionMiss | null): { text: string; settings: boolean } | null {
  if (miss === "permission") {
    return { text: "The selected text was not added: Atomic Agent needs Accessibility permission.", settings: true };
  }
  if (miss === "failed") return { text: "The selected text could not be read. Copy it and paste it here instead.", settings: false };
  return null;
}
