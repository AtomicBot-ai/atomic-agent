import { execFile } from "node:child_process";
import { clipboard, ClipboardItem, systemPreferences } from "electron";

import {
  grabSelectionByCopy,
  keystrokeCommands,
  pasteByKeystroke,
  primarySelectionCommands,
  cleanSelection,
  type ClipboardHost,
  type KeystrokeCommand,
  type KeystrokeKind,
  type PasteResult,
} from "./keystroke-clipboard.js";

/**
 * The Electron half of keystroke-clipboard.ts: Electron's clipboard, and the
 * commands run with a short timeout. Kept thin; the order of the steps is
 * the pure module's.
 *
 * What is kept and put back is the text, HTML, RTF and image a copy left;
 * anything else on the clipboard (files copied in the Finder, say) is not.
 * Electron's clipboard is the async one (read() / write(ClipboardItem[])),
 * so each kept flavour is held as a Blob by its MIME type.
 */

type Saved = Record<string, Blob>;

const kept = (type: string): boolean =>
  type === "text/plain" || type === "text/html" || type === "text/rtf" || type.startsWith("image/");

export function electronClipboardHost(): ClipboardHost<Saved> {
  return {
    save: async () => {
      const saved: Saved = {};
      for (const item of await clipboard.read()) {
        for (const type of item.types) {
          if (!kept(type) || saved[type]) continue;
          try {
            const blob = await (item.getType(type) as Promise<Blob>);
            if (blob instanceof Blob) saved[type] = blob;
          } catch { /* a flavour that cannot be read is not kept */ }
        }
      }
      return saved;
    },
    restore: async (s) => {
      if (Object.keys(s).length === 0) { clipboard.clear(); return; }
      await clipboard.write([new ClipboardItem(s)]);
    },
    readText: () => clipboard.readText(),
    writeText: (text) => clipboard.writeText(text),
    clear: () => clipboard.clear(),
  };
}

type RunOutcome = { ran: true; stdout: string } | { ran: false; missing: boolean };

function run(cmd: KeystrokeCommand, timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    try {
      execFile(cmd.file, cmd.args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (!err) { resolve({ ran: true, stdout }); return; }
        resolve({ ran: false, missing: (err as NodeJS.ErrnoException).code === "ENOENT" });
      });
    } catch {
      resolve({ ran: false, missing: true });
    }
  });
}

/** The first command that runs; a missing tool moves on to the next, a failing one stops. */
async function runFirst(cmds: KeystrokeCommand[], timeoutMs: number): Promise<RunOutcome> {
  for (const cmd of cmds) {
    const out = await run(cmd, timeoutMs);
    if (out.ran || !out.missing) return out;
  }
  return { ran: false, missing: true };
}

const env = () => ({ platform: process.platform, env: process.env });

export function pressKeys(kind: KeystrokeKind): Promise<boolean> {
  return runFirst(keystrokeCommands(kind, env()), 3000).then((o) => o.ran);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * macOS: true when this app may press keys in other apps (System Settings ›
 * Privacy & Security › Accessibility). `prompt` shows the system's own
 * request, so it is passed only for something the user just asked for.
 * Always true elsewhere.
 */
export function keystrokesAllowed(prompt = false): boolean {
  if (process.platform !== "darwin") return true;
  try {
    return systemPreferences.isTrustedAccessibilityClient(prompt);
  } catch {
    return false;
  }
}

/** The text selected in the app in front, or null. Linux reads PRIMARY; elsewhere a copy. */
export async function readSelectedText(): Promise<string | null> {
  const primary = primarySelectionCommands(env());
  if (primary.length) {
    const out = await runFirst(primary, 1500);
    return out.ran ? cleanSelection(out.stdout) : null;
  }
  if (!keystrokesAllowed(false)) return null;
  return grabSelectionByCopy(electronClipboardHost(), { press: pressKeys, sleep });
}

/** `text` typed into the app in front by a paste. */
export function pasteIntoFrontApp(text: string): Promise<PasteResult> {
  if (!keystrokesAllowed(false)) {
    void clipboard.writeText(text).catch(() => undefined);
    return Promise.resolve({ pasted: false, reason: "no-keystroke" });
  }
  return pasteByKeystroke(electronClipboardHost(), { press: pressKeys, sleep }, text);
}
