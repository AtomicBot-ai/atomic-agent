/**
 * ATO-2333 / ATO-2514: the shapes the meeting recorder (meeting-recorder.ts)
 * takes and answers, kept apart so the recorder stays one job.
 */
import type { SpeakerMethod } from "./meeting-speakers.js";
import type { MeetingChannel, MeetingStore } from "./meeting-store.js";
import type { TranscribeEngine, TranscriptSegment } from "./transcribe-file.js";

export type MeetingEvent =
  /** A chunk was heard: its segments, on the meeting's clock. */
  | { type: "segments"; id: string; index: number; segments: TranscriptSegment[]; channel: MeetingChannel }
  | { type: "chunk-failed"; id: string; index: number; error: string; channel: MeetingChannel }
  /** The recording ended: the person's Stop, the window closing, the disk. */
  | { type: "stopped"; id: string; reason: string };

export interface MeetingRecorderDeps {
  store: MeetingStore;
  engine: TranscribeEngine;
  /** Where the finished transcript is saved (the person's Meetings folder). */
  saveDir: () => string;
  emit: (ev: MeetingEvent) => void;
  now?: () => number;
}

export interface MeetingFinish {
  ok: boolean;
  error?: string;
  message?: string;
  id?: string;
  /** No speech in the whole meeting: nothing saved, the folder is gone. */
  empty?: boolean;
  path?: string;
  folder?: string;
  fileName?: string;
  document?: string;
  /** The "Make notes" message sent with the transcript attached. */
  prompt?: string;
  turns?: number;
  duration?: number;
  /** Chunks the transcriber refused twice: their audio is kept for another try. */
  failed?: number;
  /** ATO-2514: how the speakers were found (meeting-speakers.ts). */
  method?: SpeakerMethod;
}
