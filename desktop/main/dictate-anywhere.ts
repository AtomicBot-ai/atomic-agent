import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { displayUnderCursor, normalizeAccelerator, type QuickEntryDisplay, type QuickEntryPref, type Rect } from "./quick-entry.js";
import type { VoiceProbe } from "./speech.js";

/**
 * ATO-1064: dictation into any app. A global hotkey starts the on-device
 * dictation the composer's microphone uses (speech.ts), a small "Listening…"
 * pill shows, and the same hotkey again types the words into the app in
 * front by a paste (keystroke-clipboard.ts). Esc throws the take away.
 * As macOS Dictation, Superwhisper and Wispr Flow do; off until turned on.
 *
 * The pure half (no Electron import, so the node tests load it as is): the
 * saved preference, whether dictation can run here at all, the languages a
 * take uses, how the events of a take add up to its text, and where the
 * pill goes. dictate-anywhere-window.ts is the Electron half. The hotkey
 * itself is quick-entry.ts's QuickEntryShortcut, the same bookkeeping.
 */

/** ⌃⌥D on a Mac, Ctrl+Alt+D elsewhere: clear of the quick-entry box's ⌘⇧Space. */
export const DICTATE_DEFAULT_ACCELERATOR = "Control+Alt+D";

export const DICTATE_DEFAULT_PREF: QuickEntryPref = { enabled: false, accelerator: DICTATE_DEFAULT_ACCELERATOR };

/** The pill, in DIP. */
export const DICTATE_PILL_SIZE = { width: 380, height: 44 } as const;

/* ---------------- preference file ---------------- */

export function dictatePrefPath(userData: string): string {
  return join(userData, "dictate-anywhere.json");
}

export function parseDictatePref(text: string | null): QuickEntryPref {
  if (text === null) return { ...DICTATE_DEFAULT_PREF };
  try {
    const raw = JSON.parse(text) as { enabled?: unknown; accelerator?: unknown } | null;
    if (!raw || typeof raw !== "object") return { ...DICTATE_DEFAULT_PREF };
    const acc = normalizeAccelerator(raw.accelerator);
    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : DICTATE_DEFAULT_PREF.enabled,
      accelerator: acc.ok ? acc.accelerator : DICTATE_DEFAULT_ACCELERATOR,
    };
  } catch {
    return { ...DICTATE_DEFAULT_PREF };
  }
}

export function readDictatePref(userData: string): QuickEntryPref {
  try {
    return parseDictatePref(readFileSync(dictatePrefPath(userData), "utf8"));
  } catch {
    return parseDictatePref(null);
  }
}

/** Written whole, via a temp file. Best effort, never throws. */
export function writeDictatePref(userData: string, pref: QuickEntryPref): boolean {
  const path = dictatePrefPath(userData);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ enabled: pref.enabled, accelerator: pref.accelerator }) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** A combo the quick-entry box already holds is refused before it is tried. */
export function dictateClash(patch: unknown, quickEntryAccelerator: string | null): string | null {
  if (!patch || typeof patch !== "object" || !quickEntryAccelerator) return null;
  const raw = (patch as { accelerator?: unknown }).accelerator;
  if (raw === undefined) return null;
  const a = normalizeAccelerator(raw);
  const b = normalizeAccelerator(quickEntryAccelerator);
  return a.ok && b.ok && a.accelerator === b.accelerator ? "The quick entry box uses this combination. Choose another one." : null;
}

/* ---------------- can it run here ---------------- */

/**
 * Why the switch is off, or null when dictation can run. ATO-979: a Mac
 * build packaged without the speech helper (or an older macOS) says so
 * here instead of offering a switch that does nothing.
 */
export function dictateUnavailableReason(probe: Pick<VoiceProbe, "ok" | "reason" | "installed" | "canDownload">): string | null {
  if (!probe.ok) {
    switch (probe.reason) {
      case "voice-os-too-old": return "Needs macOS 26 or later, where on-device dictation runs.";
      case "voice-helper-missing": return "This build has no speech helper, so dictation cannot run.";
      case "voice-helper-failed": return "The speech helper did not answer, so dictation is off.";
      case "voice-whisper-missing":
      case "voice-whisper-model-missing":
        return "Set up voice input first: press the microphone in the composer once.";
      default: return "Voice input is not available on this computer.";
    }
  }
  if (!probe.installed.length) return "Download a dictation language first: press the microphone in the composer once.";
  return null;
}

/**
 * The languages a take uses: the ones chosen for the composer, kept to
 * those already on this computer; else the app's language, else English,
 * else the first one installed. At most two, as the composer's.
 */
export function pickDictateLocales(chosen: readonly string[], installed: readonly string[], appLocale: string): string[] {
  const have = chosen.filter((l) => installed.includes(l)).slice(0, 2);
  if (have.length) return have;
  const want = appLocale.replace("_", "-").toLowerCase();
  const lang = want.split("-")[0] ?? "";
  const exact = installed.find((l) => l.toLowerCase() === want);
  const sameLang = installed.find((l) => l.toLowerCase().split("-")[0] === lang);
  const english = installed.find((l) => l.toLowerCase().startsWith("en"));
  const pick = exact ?? sameLang ?? english ?? installed[0];
  return pick ? [pick] : [];
}

/* ---------------- a take's text ---------------- */

export type TakeOutcome = "continue" | "done" | "cancelled" | "failed";

/**
 * The events of one take (speech.ts emit) added up, by the composer's rule
 * (renderer.js voiceEvent): a `final` per segment appends and clears the
 * live `partial`; a `replace` (the second language won) takes the whole
 * text; `done`, or a `closed` after stop, ends the take.
 */
export class DictateTake {
  private final = "";
  private partial = "";
  private stopping = false;
  error: string | null = null;

  apply(ev: Record<string, unknown> | null | undefined): TakeOutcome {
    if (!ev || typeof ev !== "object") return "continue";
    const text = typeof ev.text === "string" ? ev.text : "";
    switch (ev.type) {
      case "partial": this.partial = text; return "continue";
      case "final": this.final += text; this.partial = ""; return "continue";
      case "replace": this.final = text; this.partial = ""; return "continue";
      case "done": return "done";
      case "error":
        if (ev.code === "install") return "continue";
        this.error = typeof ev.message === "string" && ev.message ? ev.message : String(ev.code ?? "dictation failed");
        return this.stopping ? "continue" : "failed";
      case "closed":
        if (ev.cancelled) return "cancelled";
        if (!this.stopping) {
          this.error = this.error ?? "Dictation stopped unexpectedly.";
          return "failed";
        }
        return "done";
      default: return "continue";
    }
  }

  /** The hotkey was pressed again: from now on the end of the take is expected. */
  stop(): void {
    this.stopping = true;
  }

  /** What the pill shows while listening. */
  live(): string {
    return (this.final + this.partial).replace(/\s+/g, " ").trim();
  }

  /** What is typed: the finals, and a partial the helper never closed. */
  text(): string {
    return (this.final + this.partial).replace(/[ \t]+/g, " ").trim();
  }
}

/** How long the end of a take may take after stop: whisper.cpp on a CPU is slow. */
export function dictateFinishTimeoutMs(platform: NodeJS.Platform | string): number {
  return platform === "darwin" ? 15_000 : 200_000;
}

/* ---------------- placement ---------------- */

/** The pill: centred near the bottom of the display under the cursor, over the Dock or taskbar's edge. */
export function dictatePillBounds(cursor: { x: number; y: number }, displays: QuickEntryDisplay[], size = DICTATE_PILL_SIZE): Rect {
  const d = displayUnderCursor(cursor, displays);
  const area = d ? d.workArea : { x: 0, y: 0, width: size.width, height: size.height };
  const width = Math.max(1, Math.min(size.width, area.width - 32));
  const height = Math.max(1, Math.min(size.height, area.height));
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + Math.max(0, area.height - height - 48)),
    width: Math.round(width),
    height: Math.round(height),
  };
}
