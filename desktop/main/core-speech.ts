/**
 * ATO-1167: read a reply aloud with a neural voice that runs on this
 * computer, through Atomic Chat Core's audio module (audio.cpp).
 *
 * The system voices (renderer/tts.js, speechSynthesis) stay the default.
 * This is the second engine the reading settings can pick: a speech model
 * from conf's audio catalog (`models/audio.json`, the same list the Atomic
 * Chat app's Audios studio shows), served by Core on loopback.
 *
 * What it takes, in Core's own words (atomic-chat-core v0.20.6+,
 * src/contracts/audio.ts, src/server/control/routes/audio.ts and
 * engine-builds.ts; the contract file has not changed through v0.24.1):
 *   1. the audio.cpp engine build: `POST /engine-builds/audio-cpp/catalog`
 *      says whether one is active, `POST /engine-builds/audio-cpp/install
 *      {task_id}` puts it in place (Core downloads it);
 *   2. the model file: Core never downloads a model (its ADR
 *      2026-10-15), so the desktop fetches the catalog's GGUF from Hugging
 *      Face into `<managed data dir>/audio/models/<path>` with the Studio's
 *      resumable, hash-checked download (studio-download.ts). Not Core's
 *      own `<core data>/audio/models`: Core's data folder is per Core
 *      version (`core/versions/<v>/data`), and a pin bump must not orphan
 *      a GB-class voice (the same reason studio-local.ts keeps diffusion
 *      models out of it);
 *   3. `POST /audio/model/load` once, with the file's absolute path (Core's
 *      src/audio/config.ts resolveModelPath takes an absolute path as is,
 *      v0.20.6 through main), then per piece of text
 *      `POST /audio/jobs {mode: "speech", request: {text}}`, polled on
 *      `GET /audio/jobs/:id` until it is `completed`, its WAV read and the
 *      clip removed from Core's gallery again (`DELETE /audio/gallery/:id`):
 *      a read-aloud is not a Studio creation.
 *
 * Core below 0.20.6 has no audio module at all. The app pins Core 0.18.6
 * today (core-bundle.ts), so `status()` answers `core-too-old` until that
 * pin moves, and the settings keep the system voices.
 *
 * No Electron here, so test/core-speech.test.mjs loads it from `out/main`.
 */

import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { StudioCoreClient } from "./studio-core-client.js";
import type { DownloadOptions, DownloadTarget } from "./studio-download.js";

/** The first Core release with `/atomic/v1/audio/*` (src/contracts/audio.ts first ships in v0.20.6). */
export const CORE_AUDIO_MIN_VERSION = "0.20.6";
export const AUDIO_ENGINE_ID = "audio-cpp";
export const AUDIO_CATALOG_URL = "https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/audio.json";
/** Pieces longer than this are split before they reach Core (its speech route takes at most 4096). */
export const SPEECH_PIECE_MAX = 600;
/** A piece that has not come back in this long is given up (a CPU run of a long sentence takes a while). */
const JOB_TIMEOUT_MS = 180_000;

/* ------------------------------------------------------------- pure --- */

/** `0.20.6` ≤ `version`, by number; anything unreadable is "no". */
export function coreHasAudio(version: string): boolean {
  const parse = (v: string) => String(v || "").trim().replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10));
  const a = parse(version);
  const b = parse(CORE_AUDIO_MIN_VERSION);
  if (a.length < 3 || a.some((n) => !Number.isFinite(n))) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return true;
}

/** One speech model of the catalog, with the one file it is served from. */
export interface SpeechModel {
  id: string;
  name: string;
  description: string;
  family: string;
  repo: string;
  revision: string;
  defaultVoice: string | null;
  defaults: Record<string, string | number | boolean>;
  file: { quant: string; path: string; filename: string; bytes: number; sha256: string | null };
}

const SAFE_PATH = /^(?!.*\.\.)[A-Za-z0-9._\-/]+$/;

/**
 * conf's `models/audio.json` → its speech models on audio.cpp, each with the
 * quant the catalog recommends (else its first). Music and effects models,
 * entries for another engine and malformed entries are left out.
 */
export function parseSpeechCatalog(raw: unknown): SpeechModel[] {
  const models = raw && typeof raw === "object" && Array.isArray((raw as { models?: unknown }).models)
    ? (raw as { models: unknown[] }).models : [];
  const out: SpeechModel[] = [];
  for (const m of models) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    if (o.mode !== "speech" || o.task !== "tts") continue;
    if (!Array.isArray(o.engines) || !o.engines.includes(AUDIO_ENGINE_ID)) continue;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const id = str(o.id), family = str(o.family), repo = str(o.repo), revision = str(o.revision);
    if (!id || !family || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[\w.-]+$/.test(revision)) continue;
    const quants = Array.isArray(o.quants) ? o.quants.filter((q): q is Record<string, unknown> => !!q && typeof q === "object") : [];
    const q = quants.find((x) => x.recommended === true) ?? quants[0];
    if (!q) continue;
    const path = str(q.path), filename = str(q.filename), quant = str(q.id);
    const bytes = typeof q.bytes === "number" && q.bytes > 0 ? q.bytes : 0;
    if (!path || !SAFE_PATH.test(path) || path.startsWith("/") || !filename || !quant || !bytes) continue;
    const sha = str(q.sha256);
    const defaults: Record<string, string | number | boolean> = {};
    if (o.defaults && typeof o.defaults === "object") {
      for (const [k, v] of Object.entries(o.defaults as Record<string, unknown>)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") defaults[k] = v;
      }
    }
    out.push({
      id, name: str(o.name) || id, description: str(o.description), family, repo, revision,
      defaultVoice: typeof o.default_voice === "string" && o.default_voice ? o.default_voice : null,
      defaults,
      file: { quant, path, filename, bytes, sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : null },
    });
  }
  return out;
}

/** Hugging Face's URL for the model file, pinned to the catalog's revision. */
export function speechModelUrl(m: SpeechModel): string {
  return `https://huggingface.co/${m.repo}/resolve/${m.revision}/${m.file.path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Core's model id for a load: `<catalog id>:<quant>`, as the Audios studio names it. */
export function speechModelId(m: SpeechModel): string {
  return `${m.id}:${m.file.quant}`;
}

/** Our voices folder under the managed data dir, shared by every Core version. */
export function speechModelsDir(dataDir: string): string {
  return join(dataDir, "audio", "models");
}

/**
 * `POST /audio/model/load`'s body (LoadAudioModelRequest). `file` is the
 * model's absolute path: Core takes an absolute path as is and a relative
 * one under its own per-version `<data>/audio/models`, where ours are not.
 */
export function loadRequest(m: SpeechModel, file: string): Record<string, unknown> {
  return {
    modelId: speechModelId(m),
    displayName: m.name,
    mode: "speech",
    file,
    family: m.family,
    task: "tts",
    ...(Object.keys(m.defaults).length ? { defaultRequestOptions: m.defaults } : {}),
    ...(m.defaultVoice ? { defaultVoice: m.defaultVoice } : {}),
  };
}

/**
 * The text cut into pieces a speech model says well in one go: whole
 * sentences, at most `max` characters, a sentence longer than that cut at
 * a comma or a space. The reader plays one piece while Core makes the next.
 */
export function speechPieces(text: string, max = SPEECH_PIECE_MAX): string[] {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?…]+(?:[.!?…]+["»”)]*|$)\s*/g) ?? [clean];
  const pieces: string[] = [];
  let cur = "";
  const flush = () => { if (cur.trim()) pieces.push(cur.trim()); cur = ""; };
  for (const s of sentences) {
    if ((cur + s).length <= max) { cur += s; continue; }
    flush();
    let rest = s;
    while (rest.length > max) {
      const cut = Math.max(rest.lastIndexOf(", ", max), rest.lastIndexOf(" ", max));
      const at = cut > max / 3 ? cut + 1 : max;
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at);
    }
    cur = rest;
  }
  flush();
  return pieces;
}

/* ------------------------------------------------------- the engine --- */

/** Why the neural voice cannot read now. The renderer owns the words. */
export type CoreSpeechReason =
  | "core-too-old"
  | "catalog-unavailable"
  | "no-model"
  | "model-not-downloaded"
  | "engine-not-installed"
  | "core-unavailable";

export interface CoreSpeechStatus {
  ok: boolean;
  reason?: CoreSpeechReason;
  message?: string;
  /** The model it reads with (or would, once downloaded). */
  model?: { id: string; name: string; bytes: number };
  /** Every speech model the catalog offers, for the picker. */
  models?: Array<{ id: string; name: string; description: string; bytes: number; downloaded: boolean }>;
}

export type PrepareEvent =
  | { type: "engine"; state: "installing" | "ready" }
  | { type: "download"; received: number; total: number }
  | { type: "verifying" };

export interface SpeakResult {
  ok: boolean;
  error?: string;
  message?: string;
  cancelled?: boolean;
  /** The clip, `data:audio/wav;base64,…`, for an <audio> element. */
  audio?: string;
  sampleRate?: number;
}

export interface CoreSpeechDeps {
  /** The Core version the app runs (core-bundle.ts BUNDLED_CORE_VERSION). */
  coreVersion: string;
  /** A Core that answers (studio-core-start.ts ensureStudioCore). */
  client: () => Promise<StudioCoreClient>;
  /** speechModelsDir(<managed data dir>): outside Core's per-version folder. */
  modelsRoot: () => string;
  /** conf's audio catalog, parsed JSON. */
  catalog: () => Promise<unknown>;
  /** studio-download.ts downloadModelFile. */
  download: (target: DownloadTarget, opts: DownloadOptions) => Promise<void>;
  /** The chosen model id ('' or unknown: the catalog's first speech model). */
  chosen: () => string;
  /** Test seams. */
  readFile?: (path: string) => Promise<Buffer>;
  fileSize?: (path: string) => Promise<number>;
  pollMs?: number;
  jobTimeoutMs?: number;
  taskId?: () => string;
}

interface AudioJobWire {
  id: string;
  state: "queued" | "generating" | "completed" | "failed" | "cancelled";
  output: { id: string; path: string; sampleRate?: number } | null;
  error?: { code?: string; message?: string };
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const errCode = (err: unknown) => (err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "FAILED");

export class CoreSpeech {
  private models: SpeechModel[] | null = null;
  private loadedFor = "";
  private current: { jobId: string | null; abort: AbortController } | null = null;
  private preparing: AbortController | null = null;

  constructor(private readonly deps: CoreSpeechDeps) {}

  private async catalog(): Promise<SpeechModel[]> {
    if (this.models?.length) return this.models;
    this.models = parseSpeechCatalog(await this.deps.catalog());
    return this.models;
  }

  private async model(id?: string): Promise<SpeechModel | null> {
    const all = await this.catalog();
    const want = id ?? this.deps.chosen();
    return all.find((m) => m.id === want) ?? all[0] ?? null;
  }

  private filePath(m: SpeechModel): string {
    return join(this.deps.modelsRoot(), ...m.file.path.split("/"));
  }

  private async downloaded(m: SpeechModel): Promise<boolean> {
    const size = this.deps.fileSize ?? (async (p: string) => (await stat(p)).size);
    try { return (await size(this.filePath(m))) === m.file.bytes; } catch { return false; }
  }

  /** What the settings show: usable now, or why not. Never downloads or installs. */
  async status(): Promise<CoreSpeechStatus> {
    if (!coreHasAudio(this.deps.coreVersion)) return { ok: false, reason: "core-too-old", message: `Atomic Core ${this.deps.coreVersion}` };
    let all: SpeechModel[];
    try { all = await this.catalog(); } catch (err) { return { ok: false, reason: "catalog-unavailable", message: errText(err) }; }
    const m = await this.model();
    if (!m) return { ok: false, reason: "no-model" };
    const models = await Promise.all(all.map(async (x) => ({ id: x.id, name: x.name, description: x.description, bytes: x.file.bytes, downloaded: await this.downloaded(x) })));
    const model = { id: m.id, name: m.name, bytes: m.file.bytes };
    if (!models.find((x) => x.id === m.id)?.downloaded) return { ok: false, reason: "model-not-downloaded", model, models };
    try {
      const client = await this.deps.client();
      const cat = await client.call<{ active: unknown }>(`/engine-builds/${AUDIO_ENGINE_ID}/catalog`, {});
      if (!cat.active) return { ok: false, reason: "engine-not-installed", model, models };
    } catch (err) {
      return { ok: false, reason: "core-unavailable", message: errText(err), model, models };
    }
    return { ok: true, model, models };
  }

  /** Put the engine build and the model file in place (the settings' Download button). */
  async prepare(id: string | undefined, onEvent: (ev: PrepareEvent) => void): Promise<{ ok: boolean; error?: string; message?: string; cancelled?: boolean }> {
    if (!coreHasAudio(this.deps.coreVersion)) return { ok: false, error: "core-too-old" };
    if (this.preparing) return { ok: false, error: "busy" };
    const abort = new AbortController();
    this.preparing = abort;
    try {
      const m = await this.model(id);
      if (!m) return { ok: false, error: "no-model" };
      const client = await this.deps.client();
      const cat = await client.call<{ active: unknown; host_backend_id?: string | null; host_reason?: string | null }>(`/engine-builds/${AUDIO_ENGINE_ID}/catalog`, {});
      if (!cat.active) {
        if (cat.host_backend_id === null) return { ok: false, error: "engine-unsupported", message: cat.host_reason ?? undefined };
        onEvent({ type: "engine", state: "installing" });
        await client.call(`/engine-builds/${AUDIO_ENGINE_ID}/install`, { task_id: (this.deps.taskId ?? randomUUID)() },
          { signal: abort.signal, timeoutMs: 30 * 60_000 });
      }
      onEvent({ type: "engine", state: "ready" });
      if (!(await this.downloaded(m))) {
        let received = 0;
        await this.deps.download(
          { url: speechModelUrl(m), savePath: this.filePath(m), bytes: m.file.bytes, sha256: m.file.sha256 },
          {
            root: this.deps.modelsRoot(),
            signal: abort.signal,
            onBytes: (delta) => { received = Math.max(0, received + delta); onEvent({ type: "download", received, total: m.file.bytes }); },
            onVerifying: () => onEvent({ type: "verifying" }),
          },
        );
      }
      return { ok: true };
    } catch (err) {
      if (abort.signal.aborted) return { ok: false, cancelled: true, error: "cancelled" };
      return { ok: false, error: errCode(err), message: errText(err) };
    } finally {
      if (this.preparing === abort) this.preparing = null;
    }
  }

  cancelPrepare(): void {
    this.preparing?.abort();
  }

  /** Say one piece of text. A new call stops the one before it. */
  async speak(text: unknown): Promise<SpeakResult> {
    const words = typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, 4000) : "";
    if (!words) return { ok: false, error: "empty" };
    if (!coreHasAudio(this.deps.coreVersion)) return { ok: false, error: "core-too-old" };
    this.cancel();
    const abort = new AbortController();
    const run = { jobId: null as string | null, abort };
    this.current = run;
    let client: StudioCoreClient | null = null;
    try {
      const m = await this.model();
      if (!m) return { ok: false, error: "no-model" };
      if (!(await this.downloaded(m))) return { ok: false, error: "model-not-downloaded" };
      client = await this.deps.client();
      const want = speechModelId(m);
      const loadKey = `${client.instanceId}:${want}`;
      if (this.loadedFor !== loadKey) {
        const st = await client.call<{ model?: { loaded?: { modelId?: string } | null } }>("/audio/status");
        if (st.model?.loaded?.modelId !== want) {
          await client.call("/audio/model/load", loadRequest(m, this.filePath(m)), { signal: abort.signal, timeoutMs: 10 * 60_000 });
        }
        this.loadedFor = loadKey;
      }
      if (abort.signal.aborted) return { ok: false, cancelled: true, error: "cancelled" };
      let job = await client.call<AudioJobWire>("/audio/jobs", { mode: "speech", request: { text: words } }, { signal: abort.signal });
      run.jobId = job.id;
      const deadline = Date.now() + (this.deps.jobTimeoutMs ?? JOB_TIMEOUT_MS);
      while (job.state === "queued" || job.state === "generating") {
        if (abort.signal.aborted) return { ok: false, cancelled: true, error: "cancelled" };
        if (Date.now() > deadline) {
          await client.call(`/audio/jobs/${encodeURIComponent(job.id)}/cancel`, {}).catch(() => {});
          return { ok: false, error: "timeout" };
        }
        await new Promise((r) => setTimeout(r, this.deps.pollMs ?? 250));
        const next = await client.call<{ job: AudioJobWire | null }>(`/audio/jobs/${encodeURIComponent(job.id)}`, undefined, { signal: abort.signal });
        if (!next.job) return { ok: false, error: "JOB_NOT_FOUND" };
        job = next.job;
      }
      if (job.state === "cancelled") return { ok: false, cancelled: true, error: "cancelled" };
      if (job.state !== "completed" || !job.output) {
        return { ok: false, error: job.error?.code ?? "FAILED", ...(job.error?.message ? { message: job.error.message } : {}) };
      }
      const bytes = await (this.deps.readFile ?? readFile)(job.output.path);
      // A read-aloud is not a Studio creation: it leaves Core's gallery again.
      await client.call(`/audio/gallery/${encodeURIComponent(job.output.id)}`, undefined, { method: "DELETE" }).catch(() => {});
      return {
        ok: true,
        audio: `data:audio/wav;base64,${bytes.toString("base64")}`,
        ...(typeof job.output.sampleRate === "number" ? { sampleRate: job.output.sampleRate } : {}),
      };
    } catch (err) {
      if (abort.signal.aborted) return { ok: false, cancelled: true, error: "cancelled" };
      // A Core that restarted forgets what was loaded.
      this.loadedFor = "";
      return { ok: false, error: errCode(err), message: errText(err) };
    } finally {
      if (this.current === run) this.current = null;
    }
  }

  /** Stop the piece being made (the reader stopped, or another reply started). */
  cancel(): void {
    const run = this.current;
    if (!run) return;
    this.current = null;
    run.abort.abort();
    if (run.jobId) {
      const id = run.jobId;
      void this.deps.client()
        .then((c) => c.call(`/audio/jobs/${encodeURIComponent(id)}/cancel`, {}))
        .catch(() => {});
    }
  }
}
