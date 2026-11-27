/**
 * ATO-2333: live meeting recording, the pure half of the transcript.
 *
 * Every chunk is transcribed on its own (times from the start of that
 * chunk); here they are put back on the meeting's clock, grouped into
 * speaker turns, and written as the text file saved for the person and
 * handed to the meeting-notes skill (starter-skills/meeting-notes, ATO-1075).
 *
 * Speakers, first slice: there is no diarization model yet, so a turn ends
 * at a pause of PAUSE_TURN_SECONDS or more, and turns alternate between
 * "Speaker 1" and "Speaker 2". The file says the labels are guessed from
 * pauses, and the meeting-notes skill keeps labels as they are unless the
 * transcript names people. A real diarizer (sherpa-onnx) replaces
 * `speakerTurns` without touching the rest.
 *
 * ATO-2514: meeting-speakers.ts now finds the speakers (Me / Them from the
 * two channels, voices from the diarizer) and `speakerTurns` is the
 * fallback; the header and the notes prompt say which way was used.
 *
 * No electron, no disk: test/meeting-transcript.test.mjs loads it from the build.
 */
import type { SpeakerMethod } from "./meeting-speakers.js";
import { formatTimestamp, type TranscriptSegment } from "./transcribe-file.js";

/** A silence this long between two segments starts a new speaker turn. */
export const PAUSE_TURN_SECONDS = 2;

export interface SpeakerTurn {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

/** One transcribed chunk as the recorder keeps it (chunk-NNNN.json). */
export interface ChunkTranscript {
  index: number;
  /** Seconds of audio in the chunk. */
  duration: number;
  /** Times from the start of the chunk. */
  segments: TranscriptSegment[];
}

/** Segments moved onto the meeting's clock. */
export function shiftSegments(segments: readonly TranscriptSegment[], offset: number): TranscriptSegment[] {
  const at = Number.isFinite(offset) && offset > 0 ? offset : 0;
  return segments.map((s) => ({ start: s.start + at, end: s.end + at, text: s.text }));
}

/**
 * Every chunk's segments on the meeting's clock, in order. A chunk's offset
 * is the sum of the durations of the chunks before it (by index), so a
 * chunk that failed and was transcribed later still lands where it was said.
 */
export function assembleSegments(chunks: readonly ChunkTranscript[]): TranscriptSegment[] {
  const sorted = [...chunks].sort((a, b) => a.index - b.index);
  const out: TranscriptSegment[] = [];
  let at = 0;
  for (const c of sorted) {
    for (const s of shiftSegments(c.segments, at)) {
      const text = String(s.text || "").replace(/\s+/g, " ").trim();
      if (text) out.push({ start: s.start, end: s.end, text });
    }
    at += Number.isFinite(c.duration) && c.duration > 0 ? c.duration : 0;
  }
  return out;
}

/** Pause-based speaker turns: a long gap starts a new turn, and the speaker alternates. */
export function speakerTurns(segments: readonly TranscriptSegment[], pause = PAUSE_TURN_SECONDS): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  let who = 0;
  for (const s of segments) {
    const text = String(s.text || "").trim();
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && s.start - last.end < pause) {
      last.end = Math.max(last.end, s.end);
      last.text = `${last.text} ${text}`;
      continue;
    }
    if (last) who = 1 - who;
    turns.push({ speaker: `Speaker ${who + 1}`, start: s.start, end: s.end, text });
  }
  return turns;
}

/** `[00:01:23] Speaker 1: text`, one line per turn. */
export function formatTurns(turns: readonly SpeakerTurn[]): string {
  return turns.map((t) => `[${formatTimestamp(t.start)}] ${t.speaker}: ${t.text}`).join("\n");
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** `2026-11-27 14-05` in local time (no colons: the name is a file name on every OS). */
export function meetingStamp(startedAt: number): string {
  const d = new Date(Number.isFinite(startedAt) ? startedAt : 0);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}`;
}

/** `Meeting 2026-11-27 14-05 transcript.txt`. */
export function meetingFileName(startedAt: number): string {
  return `Meeting ${meetingStamp(startedAt)} transcript.txt`;
}

export interface MeetingDocumentInput {
  startedAt: number;
  /** Seconds recorded. */
  duration: number;
  locale: string;
  turns: readonly SpeakerTurn[];
  /** ATO-2514: how the speakers were found; pauses when absent. */
  method?: SpeakerMethod;
}

/** The header's Speakers line, per way of finding them. */
export function speakersLine(method: SpeakerMethod = "pauses"): string {
  switch (method) {
    case "channels": return "Speakers: Me is this computer's microphone, Them is the call's sound on this computer";
    case "channels+voice": return "Speakers: Me is this computer's microphone; the call's side is told apart by voice on this computer (Them 1, Them 2)";
    case "voice": return "Speakers: told apart by voice on this computer (Speaker 1, Speaker 2), names not known";
    default: return "Speakers: guessed from pauses (Speaker 1 / Speaker 2), not recognized by voice";
  }
}

/** The saved transcript: a header the skill can read the date from, a note on speakers, the lines. */
export function meetingDocument(m: MeetingDocumentInput): string {
  const d = new Date(Number.isFinite(m.startedAt) ? m.startedAt : 0);
  const date = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
  const head = [
    `Meeting transcript, recorded on this computer`,
    `Date: ${date}`,
    `Length: ${formatTimestamp(m.duration)}`,
    `Language: ${m.locale || "unknown"}`,
    speakersLine(m.method),
  ].join("\n");
  const body = formatTurns(m.turns);
  return `${head}\n\n${body || "(no speech was heard)"}\n`;
}

/**
 * The message the "Make notes" turn sends, with the transcript attached.
 * It names the skill so the agent loads it, and repeats the skill's two
 * hard rules: only what was said, and ask before scheduling anything.
 */
export function minutesPrompt(fileName: string, method: SpeakerMethod = "pauses"): string {
  const speakers = method === "pauses"
    ? "Speaker labels were guessed from pauses; keep them unless the transcript says who is talking."
    : method === "voice"
      ? "Speaker labels were told apart by voice; keep them unless the transcript says who is talking."
      : "Me is the person who recorded the meeting; Them is the other side of the call. Keep the labels unless the transcript says who is talking.";
  return [
    `Use the meeting-notes skill to write the minutes of this meeting from the attached transcript "${fileName}".`,
    "Give a short summary, the decisions, and the action items with owners and due dates, only as they were said in the meeting.",
    speakers,
    "At the end, ask whether any action item should become a scheduled task. Do not schedule anything without a yes.",
  ].join(" ");
}
