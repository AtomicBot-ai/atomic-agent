/**
 * ATO-2514: Settings, Meetings, the list of saved meetings. Pure apart from
 * reading the folder (no electron): test/meeting-library.test.mjs drives it
 * with a temporary folder.
 *
 * Only the recorder's own files are listed and touched: a name has to be
 * exactly `Meeting YYYY-MM-DD HH-MM transcript.txt` (meeting-transcript.ts
 * meetingFileName), so a path from the page can never reach another file.
 * The minutes the meeting-notes skill writes next to it are
 * `Meeting … transcript.notes.md`; Delete moves both to the Trash.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const MEETING_FILE_RE = /^Meeting (\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2}) transcript\.txt$/;
/** More than anyone keeps; the list stays quick. */
export const MEETING_LIST_MAX = 500;

export interface MeetingFile {
  name: string;
  /** `Meeting 27 Nov 2026, 14:05` is drawn by the page from this. */
  startedAt: number;
  bytes: number;
  /** The notes file beside it, when the skill wrote one. */
  notes: string | null;
}

/** The notes file name the meeting-notes skill writes for a transcript. */
export function meetingNotesName(name: string): string {
  return name.replace(/\.txt$/, ".notes.md");
}

/** The start time in a transcript's name (local time), or NaN. */
export function meetingNameTime(name: string): number {
  const m = MEETING_FILE_RE.exec(String(name || ""));
  if (!m) return NaN;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return d.getMonth() === +m[2] - 1 ? d.getTime() : NaN;
}

/** The path of a transcript the page named, or null for a name that is not one. */
export function meetingFilePath(folder: string, name: unknown): string | null {
  if (typeof name !== "string" || !MEETING_FILE_RE.test(name)) return null;
  return join(folder, name);
}

/** The saved meetings in `folder`, newest first; [] when it does not exist yet. */
export function listMeetings(folder: string): MeetingFile[] {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const all = new Set(names);
  const out: MeetingFile[] = [];
  for (const name of names) {
    if (!MEETING_FILE_RE.test(name)) continue;
    let bytes = 0;
    try {
      const st = statSync(join(folder, name));
      if (!st.isFile()) continue;
      bytes = st.size;
    } catch {
      continue;
    }
    const notes = meetingNotesName(name);
    out.push({ name, startedAt: meetingNameTime(name), bytes, notes: all.has(notes) ? notes : null });
  }
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || (a.name < b.name ? 1 : -1));
  return out.slice(0, MEETING_LIST_MAX);
}

export type MeetingTrashResult = { ok: true } | { ok: false; error: "not-found" | "trash-failed" | "notes-trash-failed" };

/**
 * Delete: the transcript, then its notes, to the Trash (`trash` is
 * electron's shell.trashItem). Notes that stay behind (locked by an editor,
 * no permission) are "notes-trash-failed", so the page can say so.
 */
export async function trashMeeting(folder: string, name: unknown, trash: (path: string) => Promise<void>): Promise<MeetingTrashResult> {
  const path = meetingFilePath(folder, name);
  if (!path || !existsSync(path)) return { ok: false, error: "not-found" };
  try {
    await trash(path);
  } catch {
    return { ok: false, error: "trash-failed" };
  }
  const notes = join(folder, meetingNotesName(String(name)));
  if (!existsSync(notes)) return { ok: true };
  try {
    await trash(notes);
  } catch {
    return { ok: false, error: "notes-trash-failed" };
  }
  return { ok: true };
}
