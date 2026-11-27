/**
 * ATO-2514: who said what in a recorded meeting, the pure half.
 *
 * Three sources, best first:
 *   - channels: the microphone is "Me", the call's sound on this computer
 *     (meeting-system-audio.ts) is "Them". Like Granola, this is exact for
 *     a 1:1 call and needs no model.
 *   - voice: the sherpa-onnx diarizer (the agent's `diarize run`) says who
 *     spoke when; each transcript segment takes the speaker it overlaps
 *     most. On "Them" it splits a group call into Them 1, Them 2…; with
 *     no system audio it splits the microphone into Speaker 1, Speaker 2…
 *   - pauses: no channel and no diarizer: meeting-transcript.ts
 *     speakerTurns guesses from pauses, as before.
 *
 * Echo: without headphones the microphone also hears the call. A "Me"
 * segment whose words mostly match a "Them" segment said at the same time
 * is that echo and is dropped.
 *
 * No electron, no disk: test/meeting-speakers.test.mjs loads it from the build.
 */
import { PAUSE_TURN_SECONDS, speakerTurns, type SpeakerTurn } from "./meeting-transcript.js";
import type { TranscriptSegment } from "./transcribe-file.js";

export interface LabeledSegment extends TranscriptSegment {
  speaker: string;
}

/** What the diarizer printed: 0-based speaker numbers. */
export interface SpeakerSpan {
  start: number;
  end: number;
  speaker: number;
}

export type SpeakerMethod = "channels" | "channels+voice" | "voice" | "pauses";

/** Seconds of slack when matching an echo to what the call said. */
export const ECHO_SLACK_SECONDS = 1.5;
/** Share of a "Me" segment's words that must be in the call's words for it to be an echo. */
export const ECHO_WORD_SHARE = 0.6;

export function labelSegments(segments: readonly TranscriptSegment[], speaker: string): LabeledSegment[] {
  return segments.map((s) => ({ start: s.start, end: s.end, text: s.text, speaker }));
}

function words(text: string): string[] {
  return String(text || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** "Me" segments that are the call heard through the speakers: gone. */
export function dropEchoes(me: readonly LabeledSegment[], them: readonly LabeledSegment[]): LabeledSegment[] {
  return me.filter((m) => {
    const mine = words(m.text);
    if (mine.length < 2) return true;
    const near = them.filter((t) => t.start <= m.end + ECHO_SLACK_SECONDS && t.end >= m.start - ECHO_SLACK_SECONDS);
    if (!near.length) return true;
    const heard = new Set(near.flatMap((t) => words(t.text)));
    const shared = mine.filter((w) => heard.has(w)).length;
    return shared / mine.length < ECHO_WORD_SHARE;
  });
}

function overlap(a: { start: number; end: number }, b: { start: number; end: number }): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/**
 * Each segment takes the diarized speaker it overlaps most (or the nearest
 * span when it overlaps none). Speakers are numbered from 1 in the order
 * they first talk, and named by `name`.
 */
export function assignSpeakers(
  segments: readonly TranscriptSegment[],
  spans: readonly SpeakerSpan[],
  name: (n: number) => string,
): LabeledSegment[] {
  if (!spans.length) return [];
  const order = new Map<number, number>();
  const label = (raw: number) => {
    if (!order.has(raw)) order.set(raw, order.size + 1);
    return name(order.get(raw)!);
  };
  return [...segments].sort((a, b) => a.start - b.start).map((s) => {
    const by = new Map<number, number>();
    for (const sp of spans) {
      const o = overlap(s, sp);
      if (o > 0) by.set(sp.speaker, (by.get(sp.speaker) ?? 0) + o);
    }
    let best: number;
    if (by.size) best = [...by].sort((a, b) => b[1] - a[1])[0]![0];
    else {
      const mid = (s.start + s.end) / 2;
      best = [...spans].sort((a, b) => Math.abs((a.start + a.end) / 2 - mid) - Math.abs((b.start + b.end) / 2 - mid))[0]!.speaker;
    }
    return { start: s.start, end: s.end, text: s.text, speaker: label(best) };
  });
}

/** Labeled segments in time order → turns; a turn goes on while the same speaker keeps talking. */
export function mergeTurns(segments: readonly LabeledSegment[], pause = PAUSE_TURN_SECONDS): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    const text = String(s.text || "").trim();
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.speaker === s.speaker && s.start - last.end < pause) {
      last.end = Math.max(last.end, s.end);
      last.text = `${last.text} ${text}`;
      continue;
    }
    turns.push({ speaker: s.speaker, start: s.start, end: s.end, text });
  }
  return turns;
}

export interface TurnsInput {
  /** The microphone's segments, on the meeting's clock. */
  me: readonly TranscriptSegment[];
  /** The other side's segments on the meeting's clock; null when it was not recorded. */
  them: readonly TranscriptSegment[] | null;
  /** The diarizer's answer for the channel it ran on (them when there is one, else me). */
  voice?: readonly SpeakerSpan[] | null;
}

/** The meeting's turns and how the speakers were found. */
export function buildTurns(input: TurnsInput): { turns: SpeakerTurn[]; method: SpeakerMethod } {
  const voice = input.voice && input.voice.length ? input.voice : null;
  if (input.them) {
    const several = !!voice && new Set(voice.map((v) => v.speaker)).size > 1;
    const them = several ? assignSpeakers(input.them, voice!, (n) => `Them ${n}`) : labelSegments(input.them, "Them");
    const me = dropEchoes(labelSegments(input.me, "Me"), them);
    return { turns: mergeTurns([...me, ...them]), method: several ? "channels+voice" : "channels" };
  }
  if (voice) return { turns: mergeTurns(assignSpeakers(input.me, voice, (n) => `Speaker ${n}`)), method: "voice" };
  return { turns: speakerTurns(input.me), method: "pauses" };
}
