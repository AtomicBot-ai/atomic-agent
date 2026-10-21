/**
 * Studio: local diffusion models, the part Core leaves to the app.
 * No Electron (studio-ipc.ts wires it); one instance, owned by StudioMedia.
 *
 * Split of work with Atomic Chat Core v0.18.6:
 *   - ours: the catalog (conf `models/diffusion.json`, cached 1 h, with a
 *     copy in the build), downloading model files (studio-download.ts),
 *     deleting them, the fit verdict, and the load request;
 *   - Core's: the sd.cpp engine (`POST /engine-builds/sd-cpp/catalog`,
 *     `/install`, progress as `download:progress` events under our task
 *     id), loading (`POST /diffusion/model/load`, `/unload`), status
 *     (`GET /diffusion/status`), and generation.
 *
 * Every change is pushed through `emit` as one `LocalEvent`; the window
 * never polls. A download, the engine install and a load each run once:
 * a second call joins the one in flight.
 */

import { randomUUID } from "node:crypto";
import { totalmem } from "node:os";
import { mkdir, readdir, realpath, rm, rmdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";

import { diskShortfall, diskSpaceAt } from "./disk-space.js";
import { huggingFaceToken, isHuggingFaceUrl, rewriteHuggingFaceUrl } from "./huggingface.js";
import { DIFFUSION_CATALOG_BASELINE } from "./studio-diffusion-baseline.js";
import { StudioCoreError, type StudioCoreClient } from "./studio-core-client.js";
import type { StudioCoreStatus } from "./studio-core-start.js";
import { downloadModelFile, StudioDownloadError } from "./studio-download.js";
import {
  buildLoadRequest, diffusionModelsDir, findArtifact, fitFor, listModelFiles, localFamilyView, machineProfile,
  offloadFor, parseArtifactId, parseDiffusionCatalog, planArtifact, planDeletion, savePathUnder,
  type DiffusionCatalog, type DiffusionFamily, type DiffusionQuant, type LocalDownloadState, type LocalFamilyView,
  type MachineProfile, type ModelFile, type PlanEntry,
} from "./studio-local.js";
import { isInside } from "./studio-paths.js";

/** The conf file Atomic Chat reads its local families from (diffusion-catalog-registry.ts). */
export const DIFFUSION_CATALOG_URL = "https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/diffusion.json";
const CATALOG_TTL_MS = 60 * 60 * 1000;
const PROGRESS_EVERY_MS = 250;
/** Core's default `startupTimeoutSecs` is 600; the call waits a minute longer. */
const LOAD_TIMEOUT_MS = 11 * 60_000;
const ENGINE_INSTALL_TIMEOUT_MS = 30 * 60_000;

export interface LocalEngineStatus {
  /** `missing`: installs on the first local generation (or `localPrepare`). `unsupported`: this computer cannot run it. */
  state: "missing" | "installing" | "ready" | "unsupported" | "failed";
  /** A sentence to show as is. */
  message: string;
  backend: string | null;
  tag: string | null;
  progress: { transferred: number; total: number; percent: number } | null;
  error: { code: string; message: string } | null;
}

export type LocalEvent =
  | { type: "download"; download: LocalDownloadState }
  | { type: "removed"; id: string }
  | { type: "engine"; engine: LocalEngineStatus }
  | { type: "load"; id: string; state: "loading" | "loaded" | "failed"; message: string; error: { code: string; message: string } | null }
  /* Atomic Core itself being put in place before the first Studio call (studio-core-start.ts placeStudioCore). */
  | { type: "core"; core: StudioCoreStatus };

export interface StudioLocalDeps {
  /** The managed data dir, read per call. */
  dataDir: () => string;
  /** Core up and configured (starts it when needed). */
  ready: () => Promise<StudioCoreClient>;
  /** Run `fn` holding Core's client lease, so Core does not idle out mid-install or mid-load. */
  hold?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** The running Core, never starting one; null when none runs. */
  running: () => Promise<StudioCoreClient | null>;
  emit: (event: LocalEvent) => void;
  request?: typeof fetch;
  /** Physical RAM in bytes (a test run may fake it). */
  hostRamBytes?: () => number;
  /** Re-read the Hugging Face mirror setting before a download (hf-mirror.ts syncHfEndpoint). */
  beforeDownload?: () => void;
  platform?: NodeJS.Platform;
}

interface DownloadRun { state: LocalDownloadState; controller: AbortController; done: Promise<void> }

const errorOf = (err: unknown): { code: string; message: string } =>
  err instanceof StudioCoreError || err instanceof StudioDownloadError
    ? { code: err.code, message: err.message }
    : { code: "FAILED", message: err instanceof Error ? err.message : String(err) };

const pct = (transferred: number, total: number) => (total > 0 ? Math.min(100, Math.floor((transferred / total) * 100)) : 0);

export class StudioLocalModels {
  private cached: { at: number; doc: unknown; catalog: DiffusionCatalog; error: { code: string; message: string } | null } | null = null;
  private readonly downloads = new Map<string, DownloadRun>();
  /** Save paths being written now, and the run that writes each (a shared encoder is fetched once). */
  private readonly inFlight = new Map<string, Promise<void>>();
  private engine: LocalEngineStatus | null = null;
  private engineRun: Promise<void> | null = null;
  private readonly loads = new Map<string, Promise<void>>();
  /** The artifact this app loaded last, and whether with the vision projector (edit/reference). */
  private loadedHere: { id: string; vision: boolean } | null = null;

  constructor(private readonly deps: StudioLocalDeps) {}

  private hold<T>(fn: () => Promise<T>): Promise<T> {
    return this.deps.hold ? this.deps.hold(fn) : fn();
  }

  modelsDir(): string {
    return diffusionModelsDir(this.deps.dataDir());
  }

  profile(): MachineProfile | null {
    return machineProfile(this.deps.hostRamBytes?.() ?? totalmem(), this.deps.platform ?? process.platform);
  }

  /* ------------------------------------------------------------ catalog */

  /**
   * The conf catalog: the live file (cached 1 h), else the last good
   * copy, else the one in the build. `error` says why the live one was
   * not used; the families are always there.
   */
  async catalog(): Promise<{ doc: unknown; catalog: DiffusionCatalog; error: { code: string; message: string } | null }> {
    if (this.cached && Date.now() - this.cached.at < CATALOG_TTL_MS) return this.cached;
    let error: { code: string; message: string } | null = null;
    try {
      const response = await (this.deps.request ?? fetch)(DIFFUSION_CATALOG_URL, { signal: AbortSignal.timeout(8_000), redirect: "follow" });
      if (!response.ok) throw new Error(`catalog answered ${response.status}`);
      const doc: unknown = await response.json();
      const catalog = parseDiffusionCatalog(doc);
      if (!catalog || catalog.families.length === 0) throw new Error("the catalog has a schema this version does not read");
      this.cached = { at: Date.now(), doc, catalog, error: null };
      return this.cached;
    } catch (err) {
      error = { code: "CATALOG_UNAVAILABLE", message: err instanceof Error ? err.message : String(err) };
    }
    if (this.cached) return { ...this.cached, error };
    const catalog = parseDiffusionCatalog(DIFFUSION_CATALOG_BASELINE) ?? { families: [], skipped: [] };
    // Kept a short while only, so the live file is tried again soon.
    this.cached = { at: Date.now() - CATALOG_TTL_MS + 5 * 60_000, doc: DIFFUSION_CATALOG_BASELINE, catalog, error };
    return this.cached;
  }

  /** Per family: quants with size, what is on disk, the fit here, a download in flight. */
  async views(catalog: DiffusionCatalog, loadedId: string | null): Promise<Map<string, LocalFamilyView>> {
    const files = await listModelFiles(this.modelsDir());
    const profile = this.profile();
    const states = new Map([...this.downloads].map(([id, run]) => [id, run.state]));
    return new Map(catalog.families.map((f) => [f.id, localFamilyView(f, files, profile, { loadedId, downloads: states })]));
  }

  /** Downloads still running and the engine, for a window that reloaded. */
  state(): { downloads: LocalDownloadState[]; engine: LocalEngineStatus | null } {
    return { downloads: [...this.downloads.values()].map((r) => r.state), engine: this.engine };
  }

  private async artifact(id: unknown): Promise<{ family: DiffusionFamily; quant: DiffusionQuant; catalog: DiffusionCatalog }> {
    const { catalog } = await this.catalog();
    const hit = findArtifact(catalog, id);
    if (!hit) throw new StudioCoreError("That local model is not in the catalog.", "UNKNOWN_MODEL");
    return { ...hit, catalog };
  }

  /* ----------------------------------------------------------- download */

  /**
   * Start fetching what `id` (`<family>:<quant>`) still misses; resolves
   * once it started (or at once when nothing is missing). Refused before
   * any byte moves when the disk cannot hold it. `workflow` edit or
   * reference adds the vision projector a family may need for those.
   */
  async download(id: unknown, workflow = "create"): Promise<LocalDownloadState> {
    const { family, quant } = await this.artifact(id);
    const key = `${family.id}:${quant.id}`;
    const running = this.downloads.get(key);
    if (running && (running.state.state === "downloading" || running.state.state === "verifying")) return running.state;
    const root = this.modelsDir();
    await mkdir(root, { recursive: true });
    const plan = planArtifact(family, quant.id, await listModelFiles(root), root, workflow);
    if (plan.missingBytes === 0) {
      const done: LocalDownloadState = { id: key, state: "done", transferred: plan.totalBytes, total: plan.totalBytes, percent: 100, file: null, error: null };
      this.deps.emit({ type: "download", download: done });
      return done;
    }
    const partBytes = await this.partBytes(plan.entries.filter((e) => e.required && !e.present));
    const short = diskShortfall(plan.missingBytes - partBytes, await diskSpaceAt(root).catch(() => null));
    if (short) throw new StudioCoreError(short, "DISK_SPACE");
    const controller = new AbortController();
    const state: LocalDownloadState = { id: key, state: "downloading", transferred: partBytes, total: plan.missingBytes, percent: pct(partBytes, plan.missingBytes), file: null, error: null };
    const run: DownloadRun = { state, controller, done: Promise.resolve() };
    this.downloads.set(key, run);
    run.done = this.runDownload(run, family, quant, workflow).finally(() => {
      if (this.downloads.get(key) === run) this.downloads.delete(key);
    });
    this.deps.emit({ type: "download", download: { ...state } });
    return { ...state };
  }

  private async partBytes(entries: PlanEntry[]): Promise<number> {
    let sum = 0;
    for (const e of entries) {
      const s = await stat(`${e.savePath}.part`).then((x) => x.size, () => 0);
      sum += Math.min(s, e.bytes);
    }
    return sum;
  }

  private async runDownload(run: DownloadRun, family: DiffusionFamily, quant: DiffusionQuant, workflow: string): Promise<void> {
    const root = this.modelsDir();
    const s = run.state;
    let lastEmit = 0;
    const push = (force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < PROGRESS_EVERY_MS) return;
      lastEmit = now;
      s.percent = pct(s.transferred, s.total);
      this.deps.emit({ type: "download", download: { ...s, ...(s.file ? { file: { ...s.file } } : {}) } });
    };
    try {
      this.deps.beforeDownload?.();
      for (let pass = 0; ; pass++) {
        const plan = planArtifact(family, quant.id, await listModelFiles(root), root, workflow);
        const missing = plan.entries.filter((e) => e.required && !e.present);
        if (missing.length === 0) break;
        if (pass >= 3) throw new StudioCoreError(`Files are still missing after the download: ${missing.map((e) => e.relativePath).join(", ")}.`, "DOWNLOAD_FAILED");
        const own = missing.filter((e) => !this.inFlight.has(e.savePath));
        const foreign = new Set(missing.flatMap((e) => this.inFlight.get(e.savePath) ?? []));
        for (const [i, entry] of own.entries()) {
          run.controller.signal.throwIfAborted();
          // Another model's download took this shared file since the pass began: never two writers on one part file.
          const taken = this.inFlight.get(entry.savePath);
          if (taken) { foreign.add(taken); continue; }
          s.file = { index: i + 1, count: own.length, name: entry.filename.split("/").pop() ?? entry.filename };
          s.state = "downloading";
          push(true);
          const one = downloadModelFile({ url: entry.url, savePath: entry.savePath, bytes: entry.bytes, sha256: entry.sha256 }, {
            root,
            signal: run.controller.signal,
            request: this.deps.request,
            rewrite: rewriteHuggingFaceUrl,
            headers: (url): Record<string, string> => {
              const token = isHuggingFaceUrl(url) ? huggingFaceToken() : null;
              return token ? { Authorization: `Bearer ${token}` } : {};
            },
            onBytes: (delta) => { s.transferred = Math.max(0, s.transferred + delta); push(); },
            onVerifying: () => { s.state = "verifying"; push(true); },
          });
          this.inFlight.set(entry.savePath, one.catch(() => {}));
          try { await one; } finally { this.inFlight.delete(entry.savePath); }
        }
        // A file another download fetches: wait for it, and read the disk again.
        if (foreign.size) await Promise.allSettled(foreign);
      }
      s.state = "done";
      s.transferred = s.total;
      s.file = null;
      push(true);
    } catch (err) {
      const stopped = run.controller.signal.aborted;
      s.state = stopped ? "cancelled" : "failed";
      s.error = stopped ? null : errorOf(err);
      push(true);
    }
  }

  /** Stop a download; what is on disk stays, and the next download resumes it. */
  async cancel(id: unknown): Promise<{ cancelled: boolean }> {
    const key = parseArtifactId(id);
    const run = key ? this.downloads.get(`${key.family}:${key.quant}`) : undefined;
    if (!run) return { cancelled: false };
    run.controller.abort();
    await run.done;
    return { cancelled: true };
  }

  /* ------------------------------------------------------------- delete */

  /**
   * Remove an artifact's files (a stopped download's part files too). A
   * shared encoder another installed model needs stays. Unloads it from
   * Core first when it is the loaded one.
   */
  async remove(id: unknown): Promise<{ removed: number; freedBytes: number; kept: number }> {
    const { family, quant, catalog } = await this.artifact(id);
    const key = `${family.id}:${quant.id}`;
    const run = this.downloads.get(key);
    if (run) { run.controller.abort(); await run.done; }
    const client = await this.deps.running().catch(() => null);
    if (client) {
      const status = await client.call<{ model?: { loaded?: { modelId?: string } | null } }>("/diffusion/status").catch(() => null);
      if (status?.model?.loaded?.modelId === key) await client.call("/diffusion/model/unload", {}, { timeoutMs: 60_000 });
    }
    const root = this.modelsDir();
    const realRoot = await realpath(root).catch(() => null);
    const files = await listModelFiles(root);
    const { remove, kept } = planDeletion(catalog, family, quant.id, files);
    let freedBytes = 0;
    const dirs = new Set<string>();
    const removeOne = async (path: string) => {
      const real = await realpath(path).catch(() => null);
      if (!real || !realRoot || !isInside(real, realRoot) || real === realRoot) return false;
      await rm(real, { force: true });
      dirs.add(dirname(path));
      return true;
    };
    let removed = 0;
    for (const f of remove) if (await removeOne(f.path)) { removed++; freedBytes += f.bytes; }
    // Part files of what is not kept: a stopped download of this model.
    const keptPaths = new Set(kept.map((f) => f.relativePath));
    for (const e of planArtifact(family, quant.id, files, root, "edit").entries) {
      if (keptPaths.has(e.relativePath) || this.inFlight.has(e.savePath)) continue;
      const part = savePathUnder(root, `${e.relativePath}.part`);
      const size = part ? await stat(part).then((x) => x.size, () => -1) : -1;
      if (part && size >= 0 && (await removeOne(part))) freedBytes += size;
    }
    for (const dir of dirs) await this.pruneEmpty(dir, root);
    this.deps.emit({ type: "removed", id: key });
    return { removed, freedBytes, kept: kept.length };
  }

  /** Remove `dir` and its empty parents, never `root` or anything above it. */
  private async pruneEmpty(dir: string, root: string): Promise<void> {
    let at = dir;
    for (let i = 0; i < 4; i++) {
      const rel = relative(root, at);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) return;
      if ((await readdir(at).catch(() => ["?"])).length > 0) return;
      await rmdir(at).catch(() => {});
      at = dirname(at);
    }
  }

  /* ------------------------------------------------------------- engine */

  private setEngine(engine: LocalEngineStatus): LocalEngineStatus {
    this.engine = engine;
    this.deps.emit({ type: "engine", engine: { ...engine } });
    return engine;
  }

  /** Whether Core's sd.cpp engine is installed, and if not, whether this computer can take it. */
  async engineStatus(): Promise<LocalEngineStatus> {
    if (this.engineRun && this.engine) return { ...this.engine };
    const client = await this.deps.ready();
    const status = await client.call<{ install?: { state?: string; backend?: string; tag?: string } }>("/diffusion/status");
    if (status.install?.state === "installed") {
      this.engine = { state: "ready", message: "The image engine is ready.", backend: status.install.backend ?? null, tag: status.install.tag ?? null, progress: null, error: null };
      return { ...this.engine };
    }
    const catalog = await client.call<{ manifest?: unknown; host_backend_id?: string | null; host_reason?: string | null }>("/engine-builds/sd-cpp/catalog", {}, { timeoutMs: 30_000 }).catch(() => null);
    if (catalog?.manifest && !catalog.host_backend_id) {
      this.engine = { state: "unsupported", message: `This computer cannot run local image models${catalog.host_reason ? ` (${catalog.host_reason.replace(/\.$/, "")})` : ""}. Use a cloud model instead.`, backend: null, tag: null, progress: null, error: null };
      return { ...this.engine };
    }
    if (this.engine?.state === "failed") return { ...this.engine };
    this.engine = { state: "missing", message: "The image engine downloads once, the first time you generate locally.", backend: catalog?.host_backend_id ?? null, tag: null, progress: null, error: null };
    return { ...this.engine };
  }

  /** Install Core's sd.cpp engine when it is missing; joins an install in flight. */
  async ensureEngine(): Promise<LocalEngineStatus> {
    if (this.engineRun) { await this.engineRun; return this.engineStatus(); }
    const current = await this.engineStatus();
    if (current.state === "ready") return current;
    if (current.state === "unsupported") throw new StudioCoreError(current.message, "ENGINE_UNSUPPORTED");
    this.engineRun = this.hold(() => this.installEngine()).finally(() => { this.engineRun = null; });
    await this.engineRun;
    const after = await this.engineStatus();
    if (after.state !== "ready") throw new StudioCoreError(after.error?.message ?? after.message, after.error?.code ?? "ENGINE_INSTALL_FAILED");
    return after;
  }

  private async installEngine(): Promise<void> {
    const client = await this.deps.ready();
    const taskId = `studio-sdcpp-${randomUUID()}`;
    const engine = this.setEngine({ state: "installing", message: "Preparing the image engine…", backend: null, tag: null, progress: null, error: null });
    const events = new AbortController();
    let last = 0;
    void client.events((frame) => {
      const d = (frame.data && typeof frame.data === "object" ? frame.data : {}) as { taskId?: unknown; transferred?: unknown; total?: unknown; percent?: unknown };
      if (frame.event !== "download:progress" || d.taskId !== taskId) return;
      const transferred = typeof d.transferred === "number" ? d.transferred : 0;
      const total = typeof d.total === "number" ? d.total : 0;
      engine.progress = { transferred, total, percent: typeof d.percent === "number" ? Math.floor(d.percent) : pct(transferred, total) };
      if (Date.now() - last >= PROGRESS_EVERY_MS) { last = Date.now(); this.setEngine(engine); }
    }, events.signal).catch(() => { /* progress is advisory */ });
    try {
      await client.call("/engine-builds/sd-cpp/install", { task_id: taskId }, { timeoutMs: ENGINE_INSTALL_TIMEOUT_MS });
      this.setEngine({ state: "ready", message: "The image engine is ready.", backend: null, tag: null, progress: null, error: null });
    } catch (err) {
      const error = errorOf(err);
      this.setEngine({ state: "failed", message: `The image engine could not be installed: ${error.message.replace(/\.$/, "")}. Try again.`, backend: null, tag: null, progress: null, error: { code: "ENGINE_INSTALL_FAILED", message: error.message } });
    } finally {
      events.abort();
    }
  }

  /* --------------------------------------------------------------- load */

  /**
   * The artifact `id` loaded in Core, ready for a job of `workflow`:
   * downloaded (else MODEL_NOT_DOWNLOADED), the engine installed, then
   * `POST /diffusion/model/load` unless it is the loaded one already.
   * A bare family id picks its default quant on disk.
   */
  async ensureLoaded(id: unknown, workflow = "create", opts: { budgetBytes?: number | null } = {}): Promise<string> {
    const resolved = await this.resolveId(id);
    const pending = this.loads.get(resolved);
    if (pending) { await pending; return resolved; }
    const run = this.hold(() => this.load(resolved, workflow, opts.budgetBytes)).finally(() => this.loads.delete(resolved));
    this.loads.set(resolved, run);
    await run;
    return resolved;
  }

  /** The artifact id a request's `model` (an artifact id, or a bare family id) runs as. */
  resolve(id: unknown): Promise<string> {
    return this.resolveId(id);
  }

  /**
   * What `id` holds while it generates at its default size (the fit's
   * resident estimate), for studio-gpu-share; null for an id the catalog
   * does not know.
   */
  async needBytes(id: unknown): Promise<number | null> {
    const { catalog } = await this.catalog();
    const hit = findArtifact(catalog, id);
    return hit ? fitFor(hit.family, hit.quant, this.profile()).residentBytes : null;
  }

  /**
   * A video estimate without loading the model, from the fit (Core's own
   * estimate needs the model loaded, and loading it would stop the chat
   * model or the generation running). Shaped as Core's VideoEstimate, with
   * its thresholds (src/diffusion/video-estimate.ts: fits ≤ 80 %, tight
   * ≤ 100 %) and no time.
   */
  async estimateWithoutLoad(id: unknown): Promise<{ memory: { requiredBytes: number; budgetBytes: number | null; pool: "unified" | "system"; verdict: "fits" | "tight" | "exceeds" }; seconds: null; basis: "heuristic" } | null> {
    const { catalog } = await this.catalog();
    const hit = findArtifact(catalog, id);
    if (!hit) return null;
    const profile = this.profile();
    const fit = fitFor(hit.family, hit.quant, profile);
    const share = fit.budgetBytes ? fit.residentBytes / fit.budgetBytes : 1;
    return {
      memory: { requiredBytes: Math.round(fit.residentBytes), budgetBytes: fit.budgetBytes, pool: profile?.memoryKind ?? "system", verdict: share <= 0.8 ? "fits" : share <= 1 ? "tight" : "exceeds" },
      seconds: null,
      basis: "heuristic",
    };
  }

  private async resolveId(id: unknown): Promise<string> {
    if (parseArtifactId(id)) return id as string;
    const { catalog } = await this.catalog();
    const family = typeof id === "string" ? catalog.families.find((f) => f.id === id) : undefined;
    if (!family) throw new StudioCoreError("That local model is not in the catalog.", "UNKNOWN_MODEL");
    const view = (await this.views({ families: [family], skipped: [] }, null)).get(family.id)!;
    const installed = view.quants.find((q) => q.id === view.defaultQuant && q.installed) ?? view.quants.find((q) => q.installed);
    if (!installed) throw new StudioCoreError(`${family.name} is not downloaded yet.`, "MODEL_NOT_DOWNLOADED");
    return installed.id;
  }

  /**
   * `budgetBytes`: the memory left for this model (studio-gpu-share: less
   * when the chat model stays loaded beside it). The offload policy is worked
   * out against it — Core's "Auto": weights offloaded when it is tight.
   */
  private async load(id: string, workflow: string, budgetBytes?: number | null): Promise<void> {
    const { family, quant } = await this.artifact(id);
    const client = await this.deps.ready();
    const status = await client.call<{ model?: { state?: string; loaded?: { modelId?: string } | null } }>("/diffusion/status");
    const root = this.modelsDir();
    const files: ModelFile[] = await listModelFiles(root);
    const plan = planArtifact(family, quant.id, files, root, workflow);
    if (plan.missingBytes > 0) {
      const onlyProjector = plan.entries.every((e) => !e.required || e.present || e.field === "llm_vision");
      throw new StudioCoreError(
        onlyProjector
          ? `This mode needs one more file for ${family.name} (${(plan.missingBytes / 1024 ** 3).toFixed(1)} GB). Download it first.`
          : `${family.name} ${quant.label} is not downloaded yet.`,
        "MODEL_NOT_DOWNLOADED");
    }
    const vision = plan.entries.some((e) => e.required && e.field === "llm_vision");
    // Loaded already, by this app or by the agent; reloaded only to add the projector it was loaded without.
    if (status.model?.state === "loaded" && status.model.loaded?.modelId === id && (!vision || (this.loadedHere?.id === id && this.loadedHere.vision))) return;
    await this.ensureEngine();
    const name = `${family.name} ${quant.label}`;
    this.deps.emit({ type: "load", id, state: "loading", message: `Loading ${name}…`, error: null });
    try {
      const profile = this.profile();
      const fit = fitFor(family, quant, profile && typeof budgetBytes === "number" && budgetBytes < profile.budgetBytes ? { ...profile, budgetBytes: Math.max(1, budgetBytes) } : profile);
      await client.call("/diffusion/model/load", buildLoadRequest(family, quant.id, files, root, { offload: offloadFor(family, fit, this.deps.platform), workflow }), { timeoutMs: LOAD_TIMEOUT_MS });
      this.loadedHere = { id, vision };
      this.deps.emit({ type: "load", id, state: "loaded", message: `${name} is loaded.`, error: null });
    } catch (err) {
      this.deps.emit({ type: "load", id, state: "failed", message: `${name} could not be loaded.`, error: errorOf(err) });
      throw err;
    }
  }

  dispose(): void {
    for (const run of this.downloads.values()) run.controller.abort();
  }
}
