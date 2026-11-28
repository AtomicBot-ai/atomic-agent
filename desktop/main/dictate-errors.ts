/**
 * ATO-2750: what the dictation pill says when a take fails, and which
 * settings pane its button opens. A failure used to go only to a system
 * notification, so with notifications off nothing showed at all; now the
 * pill shows the line (dictate-anywhere-window.ts `fail`), and the
 * notification is kept only for when the pill cannot be shown.
 *
 * The lines are plain words: the raw error of the speech helper or the
 * microphone goes to the log, never into the pill.
 *
 * Pure: no Electron here (test/dictate-errors.test.mjs).
 */

export type DictateFailure =
  /** No dictation backend here; `reason` is dictateUnavailableReason's own line. */
  | { kind: "unavailable"; reason: string }
  /** The microphone is turned off for Atomic Agent (macOS's prompt denied, or the page was refused). */
  | { kind: "mic-off" }
  /** The speech session did not start. */
  | { kind: "start-failed" }
  /** The page could not open the microphone for another reason. */
  | { kind: "mic-failed" }
  /** The take ended with an error before any words came. */
  | { kind: "take-failed" }
  /** The words could not be typed; they are on the clipboard. `accessibility`: macOS has not allowed the key press. */
  | { kind: "paste"; accessibility: boolean };

export type DictateFix = "microphone" | "accessibility";

export interface DictateFailureView {
  line: string;
  /** The pane the button opens, or null for no button (none on this platform). */
  fix: DictateFix | null;
  /** The button's words, or null. */
  fixLabel: string | null;
}

/** The same words as Settings' button (dictate-anywhere-settings.js). */
export const DICTATE_FIX_LABEL = "Open Privacy Settings";

/** How long a failure stays in the pill before it goes on its own. */
export const DICTATE_FAILURE_MS = 10_000;

/** The pill is wider for a failure: the line and its button. */
export const DICTATE_FAILURE_PILL_SIZE = { width: 480, height: 44 } as const;

/** The settings pane a fix opens, or null where there is none (Linux). */
export function dictateFixUrl(fix: DictateFix, platform: NodeJS.Platform | string): string | null {
  if (fix === "microphone") {
    if (platform === "darwin") return "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
    if (platform === "win32") return "ms-settings:privacy-microphone";
    return null;
  }
  return platform === "darwin" ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" : null;
}

function paste(platform: NodeJS.Platform | string): string {
  return platform === "darwin" ? "⌘V" : "Ctrl+V";
}

export function dictateFailureView(f: DictateFailure, platform: NodeJS.Platform | string): DictateFailureView {
  let line = "";
  let fix: DictateFix | null = null;
  switch (f.kind) {
    case "unavailable": line = f.reason; break;
    case "mic-off": line = "Microphone access is turned off for Atomic Agent."; fix = "microphone"; break;
    case "start-failed": line = "Dictation could not start. Check the microphone and try again."; fix = "microphone"; break;
    case "mic-failed": line = "The microphone could not be opened. Check it and try again."; fix = "microphone"; break;
    case "take-failed": line = "Dictation stopped before any words came. Try again."; break;
    case "paste":
      if (f.accessibility && platform === "darwin") {
        line = `The text is on the clipboard: press ${paste(platform)}. Typing it in needs Accessibility.`;
        fix = "accessibility";
      } else {
        line = `The text is on the clipboard: press ${paste(platform)} where you want it.`;
      }
      break;
  }
  if (fix && !dictateFixUrl(fix, platform)) fix = null;
  return { line, fix, fixLabel: fix ? DICTATE_FIX_LABEL : null };
}
