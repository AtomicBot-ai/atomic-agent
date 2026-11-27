/**
 * ATO-2514: Settings, Meetings. Pure apart from the file read and write
 * (no electron import).
 *
 * The choice lives in userData (meetings.json), like pet.json and
 * voice.json: it is about this app on this computer, not the agent, so the
 * agent's config and its schema version are untouched.
 *
 *   folder       where finished transcripts are saved; null is the default,
 *                Documents/Atomic Agent/Meetings
 *   systemAudio  record the other side of a call as Them (on by default)
 *   voices       tell speakers apart by voice, downloading the diarizer on
 *                first use (off by default: it downloads about 60 MB, including a
 *                sherpa-onnx binary we do not sign, so it is opt-in)
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

export interface MeetingPrefs {
  folder: string | null;
  systemAudio: boolean;
  voices: boolean;
}

export const MEETING_PREFS_FILE = "meetings.json";
export const MEETING_PREFS_DEFAULTS: Readonly<MeetingPrefs> = { folder: null, systemAudio: true, voices: false };

/** An absolute folder path, normalized; anything else is null. */
export function cleanFolder(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > 4096 || s.includes("\0") || !isAbsolute(s)) return null;
  return normalize(s);
}

/** Whatever meetings.json held → valid settings; anything wrong reads as the default. */
export function parseMeetingPrefs(raw: unknown): MeetingPrefs {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    folder: cleanFolder(o.folder),
    systemAudio: o.systemAudio !== false,
    voices: o.voices === true,
  };
}

/** A change from Settings; unknown keys and bad values are ignored, `folder: null` resets it. */
export function mergeMeetingPrefs(cur: MeetingPrefs, patch: unknown): MeetingPrefs {
  const p = patch && typeof patch === "object" && !Array.isArray(patch) ? (patch as Record<string, unknown>) : {};
  const next: MeetingPrefs = { ...cur };
  if (typeof p.systemAudio === "boolean") next.systemAudio = p.systemAudio;
  if (typeof p.voices === "boolean") next.voices = p.voices;
  if (p.folder === null) next.folder = null;
  else if ("folder" in p) { const f = cleanFolder(p.folder); if (f) next.folder = f; }
  return next;
}

export function readMeetingPrefs(userData: string): MeetingPrefs {
  try {
    return parseMeetingPrefs(JSON.parse(readFileSync(join(userData, MEETING_PREFS_FILE), "utf8")));
  } catch {
    return { ...MEETING_PREFS_DEFAULTS };
  }
}

/** Written whole, through a temporary file, so a crash never leaves half a file. */
export function writeMeetingPrefs(userData: string, prefs: MeetingPrefs): boolean {
  try {
    mkdirSync(userData, { recursive: true });
    const file = join(userData, MEETING_PREFS_FILE);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(parseMeetingPrefs(prefs))}\n`, "utf8");
    renameSync(`${file}.tmp`, file);
    return true;
  } catch {
    return false;
  }
}
