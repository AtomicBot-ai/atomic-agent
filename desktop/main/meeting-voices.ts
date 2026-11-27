/**
 * ATO-2514: telling speakers apart by voice in a recorded meeting.
 *
 * The work is the agent's `atomic-agent diarize` (src/tools/audio in the
 * agent: sherpa-onnx v1.13.8, Apache-2.0, with pyannote segmentation-3.0,
 * MIT, and 3D-Speaker CAM++ VoxCeleb, Apache-2.0). Nothing is bundled: the
 * first meeting recorded with "Tell speakers apart" on (Settings, Meetings;
 * on by default) starts `diarize install`, about 56 to 64 MB once, with its
 * progress in the meeting panel; Settings can also get or remove it.
 *
 * Capability check: `diarize status --json`. An agent from before this
 * command, an OS with no prebuilt engine, the switch off, a download that
 * failed: the meeting falls back to Me / Them (two channels) or to the
 * pause guess, and says so in the saved file. Nothing here ever fails a
 * meeting.
 *
 * No electron: test/meeting-voices.test.mjs drives it with a fake CLI.
 */
import type { SpeakerSpan } from "./meeting-speakers.js";
import type { MeetingChannel, MeetingStore } from "./meeting-store.js";

export interface VoiceStatus {
  /** The agent answered `diarize status` (false: an older agent, or it could not run). */
  known: boolean;
  /** A prebuilt engine exists for this OS and CPU. */
  supported: boolean;
  installed: boolean;
  downloadBytes: number;
}

export type VoicesEvent =
  | { type: "voices"; state: "downloading"; fraction: number; totalBytes: number }
  | { type: "voices"; state: "ready" | "failed" | "cancelled" };

/** Runs `atomic-agent <args>`, each stdout line to `onLine`. */
export type VoicesCli = (args: string[], onLine: (line: string) => void, signal?: AbortSignal) => Promise<{ ok: boolean }>;

export interface MeetingVoicesDeps {
  cli: VoicesCli;
  /** Settings, Meetings: Tell speakers apart by voice. */
  enabled: () => boolean;
  emit: (ev: VoicesEvent) => void;
}

/** One `--json` line → its object, or null. */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(String(line || "").trim()) as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The spans of a `diarize run --json` done line, checked. */
export function spansOf(o: Record<string, unknown> | null): SpeakerSpan[] | null {
  if (!o || o.type !== "done" || !Array.isArray(o.spans)) return null;
  return o.spans.filter((s): s is SpeakerSpan => {
    const v = s as Partial<SpeakerSpan> | null;
    return !!v && typeof v.start === "number" && typeof v.end === "number" && typeof v.speaker === "number" && v.end > v.start;
  });
}

const UNKNOWN: VoiceStatus = { known: false, supported: false, installed: false, downloadBytes: 0 };

export class MeetingVoices {
  private cached: VoiceStatus | null = null;
  private installing: Promise<{ ok: boolean; error?: string }> | null = null;
  private abort: AbortController | null = null;

  constructor(private readonly deps: MeetingVoicesDeps) {}

  get downloading(): boolean {
    return this.installing !== null;
  }

  enabled(): boolean {
    return this.deps.enabled();
  }

  async status(fresh = false): Promise<VoiceStatus> {
    if (this.cached && !fresh) return this.cached;
    let line: Record<string, unknown> | null = null;
    const res = await this.deps.cli(["diarize", "status", "--json"], (l) => {
      const o = parseJsonLine(l);
      if (o?.type === "status") line = o;
    }).catch(() => ({ ok: false }));
    const o = line as Record<string, unknown> | null;
    this.cached = res.ok && o
      ? { known: true, supported: o.supported === true, installed: o.installed === true, downloadBytes: typeof o.downloadBytes === "number" ? o.downloadBytes : 0 }
      : UNKNOWN;
    return this.cached;
  }

  /** The first-use download; one at a time, a second call joins the running one. */
  install(): Promise<{ ok: boolean; error?: string }> {
    if (this.installing) return this.installing;
    const ac = new AbortController();
    this.abort = ac;
    const { emit } = this.deps;
    this.installing = (async () => {
      emit({ type: "voices", state: "downloading", fraction: 0, totalBytes: this.cached?.downloadBytes ?? 0 });
      let code = "";
      const res = await this.deps.cli(["diarize", "install", "--json"], (l) => {
        const o = parseJsonLine(l);
        if (o?.type === "progress" && typeof o.fraction === "number") {
          emit({ type: "voices", state: "downloading", fraction: o.fraction, totalBytes: typeof o.totalBytes === "number" ? o.totalBytes : 0 });
        } else if (o?.type === "error") code = typeof o.code === "string" ? o.code : "download";
      }, ac.signal).catch(() => ({ ok: false }));
      this.cached = null;
      if (res.ok) { emit({ type: "voices", state: "ready" }); return { ok: true }; }
      const cancelled = ac.signal.aborted || code === "cancelled";
      emit({ type: "voices", state: cancelled ? "cancelled" : "failed" });
      return { ok: false, error: cancelled ? "cancelled" : code || "download" };
    })().finally(() => { this.installing = null; this.abort = null; });
    return this.installing;
  }

  cancel(): void {
    this.abort?.abort();
  }

  async remove(): Promise<{ ok: boolean }> {
    this.cancel();
    const res = await this.deps.cli(["diarize", "remove", "--json"], () => {}).catch(() => ({ ok: false }));
    this.cached = null;
    return { ok: res.ok };
  }

  /**
   * At the start of a meeting: should the recorder keep each channel whole
   * for the diarizer? Yes when it is on and this OS has an engine; a missing
   * engine starts its download now, so it is ready by Make notes.
   */
  async prepare(): Promise<boolean> {
    if (!this.deps.enabled()) return false;
    const st = await this.status();
    if (!st.known || !st.supported) return false;
    if (!st.installed) void this.install();
    return true;
  }

  /** Who spoke when in a WAV; null when it cannot say. Waits up to `waitMs` for a download still running. */
  async diarize(wav: string, onProgress: (fraction: number) => void, waitMs = 180_000): Promise<SpeakerSpan[] | null> {
    if (this.installing) {
      const done = await Promise.race([this.installing, new Promise<null>((r) => setTimeout(() => r(null), waitMs))]);
      if (!done || !done.ok) return null;
    }
    const st = await this.status(true);
    if (!st.installed) return null;
    let spans: SpeakerSpan[] | null = null;
    const res = await this.deps.cli(["diarize", "run", wav, "--json"], (l) => {
      const o = parseJsonLine(l);
      if (o?.type === "progress" && typeof o.fraction === "number") onProgress(o.fraction);
      const got = spansOf(o);
      if (got) spans = got;
    }).catch(() => ({ ok: false }));
    return res.ok ? spans : null;
  }
}

/**
 * The channel's whole recording through the diarizer, its spans moved onto
 * the meeting's clock (`lead`: the other side starts that late). Null when
 * there is no whole recording or no answer.
 */
export async function diarizeChannel(
  store: MeetingStore,
  voices: Pick<MeetingVoices, "diarize">,
  id: string,
  ch: MeetingChannel,
  lead: number,
  onProgress: (fraction: number) => void,
): Promise<SpeakerSpan[] | null> {
  const wav = store.fullWav(id, ch);
  if (!wav) return null;
  const spans = await voices.diarize(wav, onProgress).catch(() => null);
  if (!spans) return null;
  const at = Number.isFinite(lead) && lead > 0 ? lead : 0;
  return spans.map((s) => ({ start: s.start + at, end: s.end + at, speaker: s.speaker }));
}
