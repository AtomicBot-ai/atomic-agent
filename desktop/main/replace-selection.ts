import type { KeystrokeCommand, PasteResult } from "./keystroke-clipboard.js";
import { stripModelPreamble } from "./replace-preamble.js";
import { SELECTED_TEXT_ACCESSIBILITY_HINT } from "./selected-text.js";

/**
 * ATO-2268: the mini chat's answer to a selection action, put back in place
 * of the selected text in the app it came from ("Replace in Safari"), the
 * way Raycast's AI Commands "Paste to active app" and Apple's Writing Tools
 * "Replace" do.
 *
 * This module is the pure half: which app the selection came from (read
 * when the hotkey reads the selection, selected-text-ipc.ts), the commands
 * that read it and bring it back to the front, and the order of the steps
 * behind injected fakes, so test/replace-selection.test.mjs runs it without
 * Electron. The clipboard save, ⌘V and the clipboard put back are
 * keystroke-clipboard.ts `pasteByKeystroke`, reused as it is.
 *
 * macOS: the mini chat is a panel that never takes the app in front away,
 * and the app is brought back by its pid. ATO-2738: Windows and Linux bring
 * back the window itself (replace-front-app.ts: its handle, xdotool, or on
 * Wayland the window the compositor gives the keyboard back to), and the
 * paste is Ctrl+V. Before anything is pasted the mini chat shows what was
 * there and what will be (renderer/mini-chat-replace-preview.js), and the
 * model's own lead-in ("Here is the rewritten text:") is taken off
 * (replace-preamble.ts).
 */

/** The app in front when the hotkey read the selection. */
export interface SourceApp {
  name: string;
  pid: number;
  /** ATO-2738, Windows: the foreground window's handle, as digits. */
  hwnd?: string;
  /** ATO-2738, Linux on X11: the active window's id, as digits. */
  xid?: string;
  /** ATO-2738, Linux on Wayland: no window known; the one under the mini chat gets the paste. */
  wayland?: boolean;
  /** ATO-2738: the button shows, and says this instead (a tool to install). */
  blocked?: string;
}

/** Whether the "Replace in …" button is offered on this platform. */
export function replaceAvailable(platform: NodeJS.Platform | string): boolean {
  return platform === "darwin" || platform === "win32" || platform === "linux";
}

/**
 * The app in front, as JSON on stdout. JavaScript for Automation through
 * NSWorkspace: no Accessibility or Automation permission needed. Null off macOS.
 */
export function frontAppCommand(platform: NodeJS.Platform | string): KeystrokeCommand | null {
  if (platform !== "darwin") return null;
  const script = [
    "ObjC.import('AppKit');",
    "var a = $.NSWorkspace.sharedWorkspace.frontmostApplication;",
    "a.isNil() ? '' : JSON.stringify({ name: ObjC.unwrap(a.localizedName), pid: a.processIdentifier });",
  ].join(" ");
  return { file: "/usr/bin/osascript", args: ["-l", "JavaScript", "-e", script] };
}

/** A pid that is safe to put in a script: a whole number above 0. */
function goodPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pid < 2 ** 31;
}

/**
 * The front-app command's stdout, checked. Null for nothing, bad output, or
 * this app itself (the hotkey pressed with our own window in front: there
 * is nothing to put back into).
 */
export function parseFrontApp(stdout: unknown, ownPid: number): SourceApp | null {
  if (typeof stdout !== "string" || !stdout.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { name, pid } = raw as { name?: unknown; pid?: unknown };
  if (!goodPid(pid) || pid === ownPid) return null;
  const label = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  return { name: label || "the app", pid };
}

/** Brings the app with this pid to the front; prints "ok" when macOS took it. Null for a bad pid or off macOS. */
export function activateAppCommand(platform: NodeJS.Platform | string, pid: number): KeystrokeCommand | null {
  if (platform !== "darwin" || !goodPid(pid)) return null;
  const script = [
    "ObjC.import('AppKit');",
    `var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid});`,
    // 2: NSApplicationActivateIgnoringOtherApps.
    "(a.isNil() || a.terminated) ? 'gone' : (a.activateWithOptions(2) ? 'ok' : 'no');",
  ].join(" ");
  return { file: "/usr/bin/osascript", args: ["-l", "JavaScript", "-e", script] };
}

/** The button's words. */
export function replaceLabel(app: SourceApp | null): string {
  return app && app.name ? `Replace in ${app.name}` : "Replace";
}

/** The longest answer put back: as much as the selection read could take, with room for a translation. */
export const REPLACE_MAX_CHARS = 32_000;

/** The answer as it is pasted: line ends made \n, trimmed; null for nothing or too long. */
export function replacementText(raw: unknown, selection?: string | null): string | null {
  if (typeof raw !== "string") return null;
  // ATO-2738: without the model's lead-in, fence or quotes around the answer (the selection's own first line stays).
  const text = stripModelPreamble(raw.replace(/\r\n/g, "\n").trim(), { selection });
  if (!text || text.length > REPLACE_MAX_CHARS) return null;
  return text;
}

export interface ReplaceDeps {
  /** macOS Accessibility, as keystroke-clipboard-host.ts `keystrokesAllowed`; `prompt` shows the system's request. */
  allowed: (prompt: boolean) => boolean;
  /** Puts the mini chat out of sight (kept alive), so it is not where the paste lands. */
  hide: () => void;
  /** ATO-2750: brings it back after a failed paste, to say so there; false when it is gone. */
  bringBack: () => boolean;
  /** Closes it for good once the answer is in place. */
  close: () => void;
  /** Brings the source app to the front; false when it could not (it quit, macOS refused). */
  activate: (app: SourceApp) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  /** keystroke-clipboard-host.ts `pasteIntoFrontApp`: clipboard kept, text on it, ⌘V, clipboard put back. */
  paste: (text: string) => Promise<PasteResult>;
  /** Leaves the text on the clipboard for a paste by hand. */
  copy: (text: string) => void;
  /** A line for the user when the mini chat could not come back (a system notification). */
  notify: (line: string) => void;
}

export interface ReplaceOptions {
  /** How long the app brought back gets to take the keyboard before ⌘V. */
  focusMs?: number;
  /** ATO-2738: the paste chord the lines name: "⌘V" (the default) or "Ctrl+V". */
  pasteKey?: string;
  /** ATO-2738: the selected text, so a lead-in that is its own first line is not taken off. */
  selection?: string | null;
}

export type ReplaceOutcome =
  | { ok: true; restored: boolean }
  /** `hidden`: the mini chat is already gone, the line went to `notify`; else the page shows `error`.
      `copy` (ATO-2750): the page offers "Copy answer" beside the line. */
  | { ok: false; hidden: boolean; error: string; copy?: true };

/** The same line the "Use selected text" switch shows: the read and the paste need the same permission. */
export const REPLACE_ACCESSIBILITY_HINT = SELECTED_TEXT_ACCESSIBILITY_HINT;

/**
 * The answer in place of the selection: checked first while the mini chat
 * can still say what is wrong; then the mini chat goes out of sight, the source app
 * comes back to the front, and the paste runs (keeping and putting back the
 * user's clipboard). The app is brought back before any key is pressed, and
 * when it cannot be, nothing is pressed: a ⌘V into some other app would be
 * worse than none. Never throws.
 */
export async function replaceInSourceApp(
  deps: ReplaceDeps,
  source: SourceApp | null,
  raw: unknown,
  opts: ReplaceOptions = {},
): Promise<ReplaceOutcome> {
  const text = replacementText(raw, opts.selection);
  if (!text) return { ok: false, hidden: false, error: "There is no answer to put back." };
  if (!source) return { ok: false, hidden: false, error: "The app the text came from is not known. Select the answer and copy it instead." };
  // ATO-2738: a tool to install first (Linux); the mini chat stays and says which.
  if (source.blocked) return { ok: false, hidden: false, error: source.blocked };
  const key = opts.pasteKey || "⌘V";
  if (!deps.allowed(false)) {
    // Asked for just now by the user: macOS's own request, as the Settings switch does.
    deps.allowed(true);
    return { ok: false, hidden: false, error: REPLACE_ACCESSIBILITY_HINT };
  }
  deps.hide();
  let back = false;
  try {
    back = await deps.activate(source);
  } catch {
    back = false;
  }
  if (!back) {
    try { deps.copy(text); } catch { /* best effort */ }
    return failed(deps, `Could not switch back to ${source.name || "the app"}. The answer is on the clipboard: press ${key} there.`);
  }
  await deps.sleep(opts.focusMs ?? 150);
  let out: PasteResult;
  try {
    out = await deps.paste(text);
  } catch {
    out = { pasted: false, reason: "failed" };
  }
  if (out.pasted) {
    try { deps.close(); } catch { /* already gone */ }
    return { ok: true, restored: out.restored };
  }
  if (out.reason === "no-keystroke") return failed(deps, `The answer is on the clipboard: press ${key} in ${source.name || "the app"}.`);
  return failed(deps,
    `The answer could not be pasted into ${source.name || "the app"}. Copy it and paste it by hand.`,
    "The answer could not be pasted. It is kept in the chat in the main window.");
}

/**
 * ATO-2750: a failure after the mini chat went out of sight. It comes back
 * with the line and "Copy answer" (Raycast keeps its window with the error
 * the same way); only when it cannot does the line go to a notification.
 */
function failed(deps: ReplaceDeps, line: string, gone = line): ReplaceOutcome {
  let back = false;
  try { back = deps.bringBack(); } catch { back = false; }
  if (back) return { ok: false, hidden: false, error: line, copy: true };
  deps.notify(gone);
  return { ok: false, hidden: true, error: gone };
}
