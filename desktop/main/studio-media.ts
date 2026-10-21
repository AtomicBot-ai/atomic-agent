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
 *   - catalog, jobs, estimate, cancel, gallery, output folders.
 */

import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { normalizeLocalFamilies, normalizeProviderModels, type StudioCatalogSection, type StudioKind } from "./studio-catalog.js";
import { StudioCoreError, type StudioCoreClient } from "./studio-core-client.js";
import { acquireStudioLease, ensureStudioCore, studioCorePaths, type StudioLease } from "./studio-core-start.js";
import { jobPath, StudioJobWatcher } from "./studio-jobs.js";
import { PickedPaths, readStudioSettings, requestSources, sourceAllowed, writeStudioSettings } from "./studio-paths.js";
import { normalizeItem, normalizeJob, toCoreImageRequest, toCoreVideoRequest, type LocalDefaults, type StudioItem, type StudioJob } from "./studio-requests.js";

export const OPENROUTER_MEDIA_BASE_URL = "https://openrouter.ai/api/v1";
/** The conf file Atomic Chat reads its local families from (diffusion-catalog-registry.ts). */
export const DIFFUSION_CATALOG_URL = "https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/diffusion.json";
const LOCAL_CATALOG_TTL_MS = 60 * 60 * 1000;
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
  request?: typeof fetch;
}

export class StudioMedia {
  readonly picked = new PickedPaths();
  private client: StudioCoreClient | null = null;
  private configuredFor = "";
  private keyFor = "";
  private lease: StudioLease | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
  private connecting: Promise<StudioCoreClient> | null = null;
  private localCatalog: { at: number; doc: unknown } | null = null;
  private lastDirs: { image?: string; video?: string } = {};
  readonly jobs: StudioJobWatcher;

  constructor(private readonly deps: StudioMediaDeps) {
    this.jobs = new StudioJobWatcher(deps.emitJob, () => this.scheduleLeaseRelease());
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
    const client = await ensureStudioCore(this.deps.dataDir(), this.deps.coreVersion);
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

  private scheduleLeaseRelease(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(() => {
      this.leaseTimer = null;
      if (this.jobs.size > 0) return;
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

  async catalog(kind: StudioKind): Promise<{ cloud: StudioCatalogSection & { keyMissing: boolean }; local: StudioCatalogSection }> {
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

  private async localSection(kind: StudioKind): Promise<StudioCatalogSection> {
    let loaded: string | null = null;
    try {
      const status = await (await this.ready()).call<{ model?: { loaded?: { modelId?: string; modality?: string } | null } }>("/diffusion/status");
      const m = status.model?.loaded;
      if (m && m.modality === kind && typeof m.modelId === "string") loaded = m.modelId;
    } catch { /* Core down: families are still listed */ }
    try {
      if (!this.localCatalog || Date.now() - this.localCatalog.at > LOCAL_CATALOG_TTL_MS) {
        const response = await (this.deps.request ?? fetch)(DIFFUSION_CATALOG_URL, { signal: AbortSignal.timeout(8_000), redirect: "follow" });
        if (!response.ok) throw new Error(`catalog answered ${response.status}`);
        this.localCatalog = { at: Date.now(), doc: await response.json() };
      }
      return { provider: "local", kind, models: normalizeLocalFamilies(this.localCatalog.doc, kind, loaded), live: false, error: null };
    } catch (err) {
      const models = this.localCatalog ? normalizeLocalFamilies(this.localCatalog.doc, kind, loaded) : [];
      return { provider: "local", kind, models, live: false, error: { code: "CATALOG_UNAVAILABLE", message: err instanceof Error ? err.message : String(err) } };
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

  /** Start one generation. The submit is never retried: a cloud provider would bill twice. */
  async generate(kind: StudioKind, raw: unknown): Promise<{ jobId: string; job: StudioJob }> {
    const cloud = (raw as { provider?: unknown } | null)?.provider !== "local";
    if (cloud && !(await this.deps.openRouterKey())) throw new StudioCoreError("No OpenRouter key.", "NO_KEY");
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
    return { jobId, job };
  }

  /** Local video only: Core answers what a clip costs on this machine; a provider never says (REMOTE_UNSUPPORTED). */
  async estimateVideo(raw: unknown): Promise<unknown | null> {
    if ((raw as { provider?: unknown } | null)?.provider !== "local") return null;
    const client = await this.ready();
    const body = toCoreVideoRequest(raw, await this.localDefaults(client, "video"));
    return (await client.call<{ estimate?: unknown }>("/diffusion/video/estimate", body, { timeoutMs: 30_000 })).estimate ?? null;
  }

  async job(kind: StudioKind, id: string): Promise<StudioJob | null> {
    const client = await this.ready();
    return normalizeJob((await client.call<{ job?: unknown }>(jobPath(kind, id))).job, kind);
  }

  async cancel(kind: StudioKind, id: string): Promise<{ cancelled: boolean; serverStopped: boolean }> {
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
    this.jobs.stop();
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    void this.lease?.release();
    this.lease = null;
  }
}

function errorOf(err: unknown): { code: string; message: string } {
  return err instanceof StudioCoreError ? { code: err.code, message: err.message } : { code: "FAILED", message: err instanceof Error ? err.message : String(err) };
}
