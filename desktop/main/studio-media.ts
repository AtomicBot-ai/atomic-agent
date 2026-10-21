/**
 * Studio (Images + Video): the desktop's client of Atomic Chat Core's media
 * API. One instance per app; no Electron here (studio-ipc.ts wires it).
 *
 * What it does with Core (atomic-chat-core v0.18.6, routes under
 * /atomic/v1 in src/server/control/routes/{diffusion,diffusion-video,
 * media,cloud}.ts):
 *   - starts or joins Core (studio-core-start.ts) and holds a client lease
 *     while a generation runs;
 *   - once per Core instance: `PUT /diffusion/config` with Core's own data
 *     folder and the output folders from Settings (Core keeps them in
 *     memory only), and `PUT /cloud/providers/openrouter` with the user's
 *     OpenRouter key (again whenever the key changes);
 *   - catalog, jobs, estimate, cancel, gallery, output folders;
 *   - local models (studio-local-models.ts): the download, the sd.cpp
 *     engine and the load happen before a local job, so a local generate
 *     or estimate needs nothing but a downloaded `<family>:<quant>`.
 */

import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { normalizeLocalFamilies, normalizeProviderModels, type StudioCatalogSection, type StudioKind } from "./studio-catalog.js";
import { StudioCoreError, type StudioCoreClient } from "./studio-core-client.js";
import type { CoreSeedResult } from "./core-seed.js";
import { acquireStudioLease, connectStudioCore, ensureStudioCore, studioCorePaths, type StudioLease } from "./studio-core-start.js";
import type { MachineProfile } from "./studio-local.js";
import { queuedLine, type GpuShare } from "./studio-gpu-share.js";
import { StudioLocalModels, type LocalEngineStatus, type LocalEvent } from "./studio-local-models.js";
import { jobPath, StudioJobWatcher } from "./studio-jobs.js";
import { PickedPaths, readStudioSettings, requestSources, sourceAllowed, writeStudioSettings } from "./studio-paths.js";
import { normalizeItem, normalizeJob, toCoreImageRequest, toCoreVideoRequest, type LocalDefaults, type StudioItem, type StudioJob } from "./studio-requests.js";

export const OPENROUTER_MEDIA_BASE_URL = "https://openrouter.ai/api/v1";
/** A lease is let go this long after the last followed job ends. */
const LEASE_GRACE_MS = 60_000;

export interface StudioMediaDeps {
  /** The managed data dir (`localModels.managed.dataDirOverride`, else `<stateDir>/models`), read per call. */
  dataDir: () => string;
  stateDir: string;
  coreVersion: string;
  /** The OpenRouter key image generation may send to Core, or null. Never logged. */
  openRouterKey: () => Promise<string | null>;
  emitJob: (job: StudioJob) => void;
  /** Local model downloads, the engine install and loads (`studio:local`). */
  emitLocal: (event: LocalEvent) => void;
  request?: typeof fetch;
  /** Physical RAM in bytes for the fit verdict; os.totalmem() when absent. */
  hostRamBytes?: () => number;
  /** Re-read the Hugging Face mirror before a model download. */
  beforeDownload?: () => void;
  /** The chat model and local generations on one memory (studio-gpu-share.ts); absent, nothing is coordinated. */
  gpu?: GpuShare;
  /** Place the installer's bundled Core when it is missing (packaged app only); without it, Core is downloaded. */
  seedCore?: (dataDir: string) => Promise<CoreSeedResult>;
  /** The fetch the Core download uses (a smoke run refuses it while offline); global fetch when absent. */
  coreRequest?: typeof fetch;
}

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

/** A local generation waiting for the one running. */
interface QueuedLocal { kind: StudioKind; raw: unknown; job: StudioJob }

export class StudioMedia {
  readonly picked = new PickedPaths();
  private client: StudioCoreClient | null = null;
  private configuredFor = "";
  private keyFor = "";
  private lease: StudioLease | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
  private connecting: Promise<StudioCoreClient> | null = null;
  private lastDirs: { image?: string; video?: string } = {};
  /** Engine installs and model loads in flight: the lease stays while any runs. */
  private localBusy = 0;
  readonly jobs: StudioJobWatcher;
  readonly local: StudioLocalModels;
  /** The local generation loading or running (one at a time); `coreJobId` once Core took it. */
  private localActive: { kind: StudioKind; coreJobId: string | null } | null = null;
  private readonly localQueue: QueuedLocal[] = [];
  /** Core job id → the queued id (`q-…`) it took over, sent with each of its changes. */
  private readonly replaced = new Map<string, string>();

  constructor(private readonly deps: StudioMediaDeps) {
    this.jobs = new StudioJobWatcher((job) => this.onJob(job), () => this.scheduleLeaseRelease());
    this.local = new StudioLocalModels({
      dataDir: deps.dataDir,
      ready: () => this.ready(),
      hold: (fn) => this.withLease(fn),
      running: () => connectStudioCore(deps.dataDir(), deps.coreVersion).catch(() => null),
      emit: deps.emitLocal,
      ...(deps.request ? { request: deps.request } : {}),
      ...(deps.hostRamBytes ? { hostRamBytes: deps.hostRamBytes } : {}),
      ...(deps.beforeDownload ? { beforeDownload: deps.beforeDownload } : {}),
    });
    deps.gpu?.attachDiffusion({
      unload: async () => {
        const client = await connectStudioCore(deps.dataDir(), deps.coreVersion).catch(() => null);
        if (client) await client.call("/diffusion/model/unload", {}, { timeoutMs: 60_000 });
      },
    });
  }

  /** Every job change on its way to the window; the end of the running local generation lets the next one (or the chat model) go. */
  private onJob(job: StudioJob): void {
    const replaces = this.replaced.get(job.id);
    this.deps.emitJob(replaces ? { ...job, replaces } : job);
    if (!TERMINAL_STATES.has(job.state)) return;
    this.replaced.delete(job.id);
    if (this.localActive && this.localActive.coreJobId === job.id) void this.localDone();
  }

  private get dataFolder(): string {
    return studioCorePaths(this.deps.dataDir(), this.deps.coreVersion).dataFolder;
  }

  /** Core up, configured for Studio, and the key registered. */
  async ready(): Promise<StudioCoreClient> {
    this.connecting ??= this.connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async connect(): Promise<StudioCoreClient> {
    // A cloud-route install never started a local model, so Core may not be here yet: it is put in place first,
    // with "Preparing the engine…" pushed as `core` events (CONTRACT.md).
    const client = await ensureStudioCore(this.deps.dataDir(), this.deps.coreVersion, {
      ...(this.deps.seedCore ? { seed: this.deps.seedCore } : {}),
      ...(this.deps.coreRequest ? { install: { request: this.deps.coreRequest } } : {}),
      onStatus: (core) => this.deps.emitLocal({ type: "core", core }),
    });
    if (this.client?.instanceId !== client.instanceId) {
      await this.lease?.release();
      this.lease = null;
      this.configuredFor = "";
      this.keyFor = "";
    }
    this.client = client;
    if (this.configuredFor !== client.instanceId) {
      await this.configure(client);
      this.configuredFor = client.instanceId;
    }
    const key = await this.deps.openRouterKey();
    const stamp = key ? `${client.instanceId}:${createHash("sha256").update(key).digest("hex")}` : "";
    if (key && this.keyFor !== stamp) {
      // Core replaces base_url, models and custom_headers on every PUT; the agent sends the same body.
      await client.call("/cloud/providers/openrouter", {
        api_key: key,
        base_url: OPENROUTER_MEDIA_BASE_URL,
        custom_headers: [],
        models: [],
        media: { image_api: "openrouter-images", video_api: "openrouter-videos", models: [] },
      }, { method: "PUT" });
      this.keyFor = stamp;
    }
    return client;
  }

  private async configure(client: StudioCoreClient): Promise<void> {
    const s = readStudioSettings(this.deps.stateDir);
    const status = await client.call<{ outputDir?: string; videoOutputDir?: string }>("/diffusion/config", {
      dataFolder: this.dataFolder,
      ...(s.imageOutputDir ? { outputDir: s.imageOutputDir } : {}),
      ...(s.videoOutputDir ? { videoOutputDir: s.videoOutputDir } : {}),
    }, { method: "PUT", timeoutMs: 30_000 });
    this.lastDirs = { image: status.outputDir, video: status.videoOutputDir };
  }

  private async holdLease(client: StudioCoreClient): Promise<void> {
    if (this.leaseTimer) { clearTimeout(this.leaseTimer); this.leaseTimer = null; }
    this.lease ??= await acquireStudioLease(client).catch(() => null);
  }

  /** Hold the lease while `fn` runs (an engine install or a model load can take minutes with no job yet). */
  private async withLease<T>(fn: () => Promise<T>): Promise<T> {
    this.localBusy++;
    try {
      await this.holdLease(await this.ready());
      return await fn();
    } finally {
      this.localBusy--;
      this.scheduleLeaseRelease();
    }
  }

  private scheduleLeaseRelease(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(() => {
      this.leaseTimer = null;
      if (this.jobs.size > 0 || this.localBusy > 0) return;
      void this.lease?.release();
      this.lease = null;
    }, LEASE_GRACE_MS);
    this.leaseTimer.unref();
  }

  /** The folders Studio files may be read from: what Core reported, the defaults, and Settings. */
  roots(): string[] {
    const s = readStudioSettings(this.deps.stateDir);
    const data = this.dataFolder;
    return [this.lastDirs.image, this.lastDirs.video, s.imageOutputDir, s.videoOutputDir, join(data, "images"), join(data, "videos")]
      .filter((r): r is string => typeof r === "string" && r.length > 0);
  }

  /* ------------------------------------------------------------ catalog */

  async catalog(kind: StudioKind): Promise<{ cloud: StudioCatalogSection & { keyMissing: boolean }; local: StudioCatalogSection & LocalSectionExtra }> {
    const keyMissing = !(await this.deps.openRouterKey());
    let cloud: StudioCatalogSection;
    try {
      const client = await this.ready();
      cloud = normalizeProviderModels(await client.call(`/media/providers/openrouter/models?kind=${kind}`, undefined, { timeoutMs: 20_000 }), kind);
    } catch (err) {
      cloud = { provider: "openrouter", kind, models: [], live: false, error: errorOf(err) };
    }
    return { cloud: { ...cloud, keyMissing }, local: await this.localSection(kind) };
  }

  private async localSection(kind: StudioKind): Promise<StudioCatalogSection & LocalSectionExtra> {
    let loaded: string | null = null;
    try {
      const status = await (await this.ready()).call<{ model?: { loaded?: { modelId?: string; modality?: string } | null } }>("/diffusion/status");
      const m = status.model?.loaded;
      if (m && m.modality === kind && typeof m.modelId === "string") loaded = m.modelId;
    } catch { /* Core down: families are still listed */ }
    const extra: LocalSectionExtra = { machine: this.local.profile(), modelsDir: this.local.modelsDir(), engine: this.local.state().engine };
    try {
      const { doc, catalog, error } = await this.local.catalog();
      const views = await this.local.views(catalog, loaded);
      // A family the parser refused (an unsafe path, a field it does not know) is not offered.
      const models = normalizeLocalFamilies(doc, kind, loaded)
        .filter((m) => views.has(m.id))
        .map((m) => {
          const view = views.get(m.id)!;
          /* The Studio hint (CONTRACT.md "Memory shared with the chat model"):
             a quant that cannot stay loaded beside the local chat model pauses it while it runs. */
          const gpu = this.deps.gpu;
          const quants = view.quants.map((q) => ({ ...q, pausesChat: gpu ? gpu.pausesChat(q.fit.residentBytes) : false }));
          return { ...m, local: { ...m.local!, ...view, quants } };
        });
      return { provider: "local", kind, models, live: false, error, ...extra };
    } catch (err) {
      return { provider: "local", kind, models: [], live: false, error: errorOf(err), ...extra };
    }
  }

  /* ---------------------------------------------------------- generation */

  private async localDefaults(client: StudioCoreClient, kind: StudioKind): Promise<LocalDefaults | undefined> {
    const caps = await client.call<{ defaults?: Partial<LocalDefaults> }>(kind === "video" ? "/diffusion/video/capabilities" : "/diffusion/capabilities").catch(() => null);
    const d = caps?.defaults;
    return d && typeof d.width === "number" && typeof d.height === "number" && typeof d.steps === "number" && typeof d.cfgScale === "number"
      ? { width: d.width, height: d.height, steps: d.steps, cfgScale: d.cfgScale }
      : undefined;
  }

  /**
   * Start one generation. The submit is never retried: a cloud provider would
   * bill twice. Local ones run one at a time: a second answers at once as a
   * `queued` job (`q-…`) that starts when the first ends.
   */
  async generate(kind: StudioKind, raw: unknown): Promise<{ jobId: string; job: StudioJob }> {
    const cloud = (raw as { provider?: unknown } | null)?.provider !== "local";
    if (cloud && !(await this.deps.openRouterKey())) throw new StudioCoreError("No OpenRouter key.", "NO_KEY");
    if (cloud) return this.submit(kind, raw, true);
    if (this.localActive) return this.enqueueLocal(kind, raw);
    return this.runLocal(kind, raw);
  }

  /**
   * One local generation: the chat model makes room when the two do not fit
   * (studio-gpu-share), the model loads with the offload that memory calls
   * for, and the job goes to Core. Whatever ends it — the job, or a failure
   * before Core took it — lets the next queued one or the chat model go.
   */
  private async runLocal(kind: StudioKind, raw: unknown, replaces?: string): Promise<{ jobId: string; job: StudioJob }> {
    const active: { kind: StudioKind; coreJobId: string | null } = { kind, coreJobId: null };
    this.localActive = active;
    try {
      let budgetBytes: number | null | undefined;
      const gpu = this.deps.gpu;
      const r = raw as { model?: unknown } | null;
      const asked = r && typeof r.model === "string" ? r.model : "";
      if (gpu && asked) {
        const resolved = await this.local.resolve(asked).catch(() => null);
        const bytes = resolved ? await this.local.needBytes(resolved).catch(() => null) : null;
        // Under the lease: the chat model's stop must not find Core idle and retire it under Studio.
        ({ budgetBytes } = await this.withLease(() => gpu.diffusionStart({ kind, model: resolved ?? asked, bytes })));
      }
      await this.prepareLocal(raw, budgetBytes);
      const out = await this.submit(kind, raw, false, replaces);
      active.coreJobId = out.jobId;
      this.deps.gpu?.jobStarted(out.jobId);
      // Over already (the watcher follows only a job still running): the next one goes now.
      if (!this.jobs.get(out.jobId)) void this.localDone();
      return out;
    } catch (err) {
      void this.localDone();
      throw err;
    }
  }

  /** The running local generation is over: the next queued one starts, else the chat model may come back. */
  private async localDone(): Promise<void> {
    if (!this.localActive) return;
    const next = this.localQueue.shift();
    // Held for the next one at once, so a generate that comes meanwhile queues behind it.
    this.localActive = next ? { kind: next.kind, coreJobId: null } : null;
    this.deps.gpu?.setQueued(this.localQueue.length);
    this.renumberQueue();
    if (this.deps.gpu) {
      const loaded = await this.loadedModelId().catch(() => null);
      await this.deps.gpu.diffusionEnd({ more: !!next, loaded: loaded !== null }).catch(() => undefined);
    }
    if (!next) return;
    this.runLocal(next.kind, next.raw, next.job.id).catch((err) => {
      const e = errorOf(err);
      this.deps.emitJob({ ...next.job, state: "failed", queue: null, error: e, finishedAtMs: Date.now() });
    });
  }

  private enqueueLocal(kind: StudioKind, raw: unknown): { jobId: string; job: StudioJob } {
    const id = `q-${randomUUID()}`;
    const job: StudioJob = {
      id, kind, state: "queued", cloud: false, model: String((raw as { model?: unknown } | null)?.model ?? ""),
      progress: null, outputs: [], error: null, createdAtMs: Date.now(), finishedAtMs: null,
      queue: { position: this.localQueue.length + 1, message: queuedLine(this.localActive?.kind ?? kind) },
    };
    this.localQueue.push({ kind, raw, job });
    this.deps.gpu?.setQueued(this.localQueue.length);
    this.deps.emitJob(job);
    return { jobId: id, job: { ...job } };
  }

  /** Positions moved up: each queued job says its new place. */
  private renumberQueue(): void {
    const head = this.localActive?.kind;
    this.localQueue.forEach((q, i) => {
      const queue = { position: i + 1, message: queuedLine(head ?? q.kind) };
      if (q.job.queue?.position === queue.position && q.job.queue.message === queue.message) return;
      q.job = { ...q.job, queue };
      this.deps.emitJob(q.job);
    });
  }

  /** The diffusion model in Core now, never starting Core; null when none. */
  private async loadedModelId(): Promise<string | null> {
    const client = await connectStudioCore(this.deps.dataDir(), this.deps.coreVersion).catch(() => null);
    if (!client) return null;
    const status = await client.call<{ model?: { state?: string; loaded?: { modelId?: string } | null } }>("/diffusion/status");
    return status.model?.state === "loaded" && typeof status.model.loaded?.modelId === "string" ? status.model.loaded.modelId : null;
  }

  /** Every generation still running or queued that this app started (a window that reloaded). */
  activeJobs(): StudioJob[] {
    return [...this.jobs.list(), ...this.localQueue.map((q) => ({ ...q.job }))];
  }

  /**
   * `studio:localLoad`: a model loaded ahead of a generation, with the same
   * room made for it. Refused while a local generation runs (another model
   * would replace the one it uses).
   */
  async loadLocal(id: string, workflow: string): Promise<string> {
    if (this.localActive) throw new StudioCoreError("Wait for the current generation to finish, then load another model.", "JOB_BUSY");
    const gpu = this.deps.gpu;
    if (!gpu) return this.local.ensureLoaded(id, workflow);
    // Held like a generation, so a generate that comes meanwhile queues behind the load.
    this.localActive = { kind: "image", coreJobId: null };
    try {
      const resolved = await this.local.resolve(id);
      const bytes = await this.local.needBytes(resolved).catch(() => null);
      const { budgetBytes } = await this.withLease(() => gpu.diffusionStart({ kind: "image", model: resolved, bytes }));
      await this.local.ensureLoaded(resolved, workflow, { budgetBytes });
      return resolved;
    } finally {
      await this.localDone();
    }
  }

  private async submit(kind: StudioKind, raw: unknown, cloud: boolean, replaces?: string): Promise<{ jobId: string; job: StudioJob }> {
    const client = await this.ready();
    const local = cloud ? undefined : await this.localDefaults(client, kind);
    const body = kind === "video" ? toCoreVideoRequest(raw, local) : toCoreImageRequest(raw, local);
    for (const source of requestSources(body)) {
      if (!sourceAllowed(source, this.roots(), this.picked)) {
        throw new StudioCoreError("That image can only be used after choosing it with Add image, or from the gallery.", "OUTSIDE");
      }
    }
    await this.holdLease(client);
    let jobId: string;
    try {
      const answer = await client.call<{ jobId?: unknown }>(kind === "video" ? "/diffusion/video/jobs" : "/diffusion/jobs", body, { timeoutMs: 60_000 });
      if (typeof answer.jobId !== "string" || !answer.jobId) throw new StudioCoreError("Atomic Core did not return a job id.", "BAD_ANSWER");
      jobId = answer.jobId;
      if (replaces) this.replaced.set(jobId, replaces);
    } catch (err) {
      if (this.jobs.size === 0) this.scheduleLeaseRelease();
      throw err;
    }
    const first = await client.call<{ job?: unknown }>(jobPath(kind, jobId)).catch(() => ({ job: null }));
    const job: StudioJob = normalizeJob(first.job, kind) ?? {
      id: jobId, kind, state: "queued", cloud, model: String((raw as { model?: unknown }).model ?? ""),
      progress: null, outputs: [], error: null, createdAtMs: Date.now(), finishedAtMs: null,
    };
    this.jobs.follow(client, job);
    if (this.jobs.size === 0) this.scheduleLeaseRelease();
    return { jobId, job: replaces ? { ...job, replaces } : job };
  }

  /** Local video only: Core answers what a clip costs on this machine; a provider never says (REMOTE_UNSUPPORTED). */
  async estimateVideo(raw: unknown): Promise<unknown | null> {
    if ((raw as { provider?: unknown } | null)?.provider !== "local") return null;
    /* Core estimates against the loaded model only. Loading another one for
       an estimate would stop the generation running, or pause the chat
       model, for a figure: then the fit's own estimate answers instead. */
    const model = (raw as { model?: unknown } | null)?.model;
    if (typeof model === "string" && model && (this.localActive || this.deps.gpu)) {
      const resolved = await this.local.resolve(model);
      const loaded = await this.loadedModelId().catch(() => null);
      if (loaded !== resolved && (this.localActive || this.deps.gpu?.pausesChat(await this.local.needBytes(resolved).catch(() => null)))) {
        return this.local.estimateWithoutLoad(resolved);
      }
    }
    await this.prepareLocal(raw);
    const client = await this.ready();
    const body = toCoreVideoRequest(raw, await this.localDefaults(client, "video"));
    return (await client.call<{ estimate?: unknown }>("/diffusion/video/estimate", body, { timeoutMs: 30_000 })).estimate ?? null;
  }

  /**
   * A local request's model, downloaded, with the engine installed and the
   * model loaded; `model` may be a bare family id (its quant on disk).
   * The request's `model` is set to the artifact id Core loaded.
   */
  private async prepareLocal(raw: unknown, budgetBytes?: number | null): Promise<void> {
    const r = raw as { model?: unknown; mode?: unknown } | null;
    // Nothing to load for a request the mapping refuses anyway ("Pick a model first.", local image-to-video).
    if (!r || typeof r !== "object" || typeof r.model !== "string" || !r.model || r.mode === "image-to-video") return;
    const loaded = await this.local.ensureLoaded(r.model, typeof r.mode === "string" ? r.mode : "create", { budgetBytes });
    (r as { model?: unknown }).model = loaded;
  }

  async job(kind: StudioKind, id: string): Promise<StudioJob | null> {
    if (id.startsWith("q-")) {
      const q = this.localQueue.find((x) => x.job.id === id);
      return q ? { ...q.job } : null;
    }
    const client = await this.ready();
    return normalizeJob((await client.call<{ job?: unknown }>(jobPath(kind, id))).job, kind);
  }

  async cancel(kind: StudioKind, id: string): Promise<{ cancelled: boolean; serverStopped: boolean }> {
    if (id.startsWith("q-")) {
      const at = this.localQueue.findIndex((x) => x.job.id === id);
      if (at < 0) return { cancelled: false, serverStopped: false };
      const [q] = this.localQueue.splice(at, 1);
      this.deps.gpu?.setQueued(this.localQueue.length);
      this.deps.emitJob({ ...q!.job, state: "cancelled", queue: null, error: { code: "CANCELLED", message: "Stopped before it started." }, finishedAtMs: Date.now() });
      this.renumberQueue();
      return { cancelled: true, serverStopped: false };
    }
    const client = await this.ready();
    const answer = await client.call<{ cancelled?: boolean; serverStopped?: boolean }>(`${jobPath(kind, id)}/cancel`, {}, { timeoutMs: 15_000 });
    return { cancelled: answer.cancelled === true, serverStopped: answer.serverStopped === true };
  }

  /* ------------------------------------------------------------- gallery */

  private galleryPath(kind: StudioKind): string {
    return kind === "video" ? "/diffusion/video/gallery" : "/diffusion/gallery";
  }

  async gallery(kind: StudioKind, opts: { offset?: number; limit?: number; includeArchived?: boolean } = {}): Promise<{ items: StudioItem[]; hasMore: boolean; total: number }> {
    const client = await this.ready();
    const offset = Number.isInteger(opts.offset) && opts.offset! >= 0 ? opts.offset! : 0;
    const limit = Number.isInteger(opts.limit) && opts.limit! > 0 ? Math.min(opts.limit!, 200) : 50;
    const q = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    if (typeof opts.includeArchived === "boolean") q.set("includeArchived", String(opts.includeArchived));
    const page = await client.call<{ items?: unknown[]; hasMore?: boolean; total?: number }>(`${this.galleryPath(kind)}?${q.toString()}`);
    return {
      items: (page.items ?? []).map((i) => normalizeItem(i, kind)).filter((i): i is StudioItem => i !== null),
      hasMore: page.hasMore === true,
      total: typeof page.total === "number" ? page.total : 0,
    };
  }

  async galleryDelete(kind: StudioKind, ids: string[]): Promise<void> {
    await (await this.ready()).call(`${this.galleryPath(kind)}/delete`, { ids });
  }

  async pin(kind: StudioKind, id: string, on: boolean): Promise<StudioItem | null> {
    const item = await (await this.ready()).call(`${this.galleryPath(kind)}/${encodeURIComponent(id)}/flags`, { pinned: on }, { method: "PATCH" });
    return normalizeItem(item, kind);
  }

  /* ------------------------------------------------------ output folders */

  async outputDir(kind: StudioKind): Promise<{ path: string; isDefault: boolean }> {
    const s = readStudioSettings(this.deps.stateDir);
    const chosen = kind === "video" ? s.videoOutputDir : s.imageOutputDir;
    try {
      const status = await (await this.ready()).call<{ outputDir?: string; videoOutputDir?: string }>("/diffusion/status");
      this.lastDirs = { image: status.outputDir, video: status.videoOutputDir };
    } catch { /* Core down: what Settings or the default says */ }
    const reported = kind === "video" ? this.lastDirs.video : this.lastDirs.image;
    return { path: reported ?? chosen ?? join(this.dataFolder, kind === "video" ? "videos" : "images"), isDefault: !chosen };
  }

  /** `path` null or empty: back to `<Core data>/images` (or videos). Takes effect for the next generation. */
  async setOutputDir(kind: StudioKind, path: string | null): Promise<{ path: string; isDefault: boolean }> {
    if (path && (!isAbsolute(path) || path.includes("\0"))) throw new StudioCoreError("Pick a folder by its full path.", "INVALID_REQUEST");
    const s = readStudioSettings(this.deps.stateDir);
    const key = kind === "video" ? "videoOutputDir" : "imageOutputDir";
    if (path) s[key] = path;
    else delete s[key];
    writeStudioSettings(this.deps.stateDir, s);
    if (this.client) { this.configuredFor = ""; await this.ready(); }
    return this.outputDir(kind);
  }

  dispose(): void {
    this.localQueue.length = 0;
    this.deps.gpu?.dispose();
    this.jobs.stop();
    this.local.dispose();
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    void this.lease?.release();
    this.lease = null;
  }
}

/** What the local section says beside the families. */
export interface LocalSectionExtra {
  /** This machine as the fit sees it (RAM, the share a model may use); null when unknown. */
  machine: MachineProfile | null;
  /** Where local model files are kept. */
  modelsDir: string;
  /** The image engine as last seen (null until `localEngine` or a local job asked). */
  engine: LocalEngineStatus | null;
}

function errorOf(err: unknown): { code: string; message: string } {
  return err instanceof StudioCoreError ? { code: err.code, message: err.message } : { code: "FAILED", message: err instanceof Error ? err.message : String(err) };
}
