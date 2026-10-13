import { withCoreOperation } from "./core-operation.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DownloadFileOptions } from "../downloads/download-file.js";
import { CoreUnavailableError, toCoreUnavailable } from "./core-errors.js";
import { CORE_VERSION, activeCoreVersion, coreRoot, coreVersionDir, readCoreBackend, writeCoreJson, type CoreBackend } from "./core-state.js";
import { connectCore, CoreRequestError, withCoreClient, type CoreControlClient } from "./core-client.js";
import { installCore, isCoreInstalled, withCoreRetries } from "./core-install.js";

interface Catalog {
  recommended: string | null;
  recommended_installed: string | null;
  releases?: Array<{ tag: string; variants: Array<{ id: string; asset?: string }> }>;
}

/** Core and its backend for `version` (default: the active one) are on disk. */
export function isCoreBackendInstalled(dataDir: string, version = activeCoreVersion(dataDir)): boolean {
  return isCoreInstalled(dataDir, version) && readCoreBackend(dataDir, version) !== null;
}

/** The active Core serves no model session (or is not running at all). */
async function activeCoreIdle(dataDir: string): Promise<boolean> {
  const current = await connectCore(dataDir, activeCoreVersion(dataDir));
  return !current || (await current.snapshot()).sessions.length === 0;
}

function writeActiveVersion(dataDir: string, version: string): void {
  const previous = activeCoreVersion(dataDir);
  if (previous === version) return;
  writeCoreJson(join(coreRoot(dataDir), "active.json"), { version, previous });
}

/**
 * Switch the active Core to `version`, already installed beside it, when
 * the active Core serves no model. Returns false, changing nothing, while
 * a model runs; the next idle start switches.
 */
export async function activateCoreVersion(dataDir: string, version = CORE_VERSION): Promise<boolean> {
  if (activeCoreVersion(dataDir) === version) return true;
  if (!isCoreBackendInstalled(dataDir, version)) return false;
  return withCoreOperation(dataDir, async () => {
    if (!(await activeCoreIdle(dataDir))) return false;
    writeActiveVersion(dataDir, version);
    return true;
  });
}

/** A dropped connection or a 5xx from Core is worth another install call; a refusal is not. */
function isRetryableCoreCall(err: unknown): boolean {
  if (err instanceof CoreRequestError) return err.status >= 500;
  return err instanceof TypeError && /fetch failed/.test(err.message);
}

/**
 * Ask Core to install one `provider` backend (the TurboQuant fork that runs
 * chat, or stock llama.cpp for the embedding module), retried up to three
 * times with backoff on a network failure or a 5xx. Each attempt has its own
 * task id, progress subscription and cancel hook; a cancelled install is
 * never retried.
 */
export async function installSelectedBackend(client: CoreControlClient, provider: "llamacpp" | "llamacpp-upstream", body: { version: string; backend: string; asset_name?: string }, opts: DownloadFileOptions): Promise<{ path: string }> {
  return withCoreRetries(async () => {
    const taskId = `agent-backend-${randomUUID()}`;
    const cancel = () => { void client.call(`/downloads/${taskId}/cancel`, {}).catch(() => {}); };
    const stopEvents = await client.downloadEvents(taskId, opts.onProgress ?? (() => {}), opts.signal);
    opts.signal?.addEventListener("abort", cancel, { once: true });
    opts.onProgress?.(0, 0, 0);
    try {
      return await client.call<{ path: string }>(`/backends/${provider}/install`, { ...body, task_id: taskId }, { signal: opts.signal, timeoutMs: 15 * 60_000 });
    } finally { opts.signal?.removeEventListener("abort", cancel); await stopEvents(); }
  }, isRetryableCoreCall, opts.signal);
}

/**
 * Core owns platform/hardware selection and backend acquisition, as in
 * Atomic Chat. Each version installs into its own folder, so a newer pin is
 * installed beside an older active Core even while that one serves models;
 * only switching the active version waits until no model runs
 * (`activated: false`; `activateCoreVersion` switches at the next idle start).
 * Reinstalling the active version still needs its models stopped. Exclusive:
 * never waits for another engine operation.
 */
export async function installCoreBackend(dataDir: string, opts: DownloadFileOptions = {}, version = CORE_VERSION): Promise<{ ok: true; tag: string; activated: boolean }> {
  return withCoreOperation(dataDir, async () => {
  const idle = await activeCoreIdle(dataDir);
  if (!idle && version === activeCoreVersion(dataDir)) {
    throw new Error("Stop local models before updating the engine. Your running models are unchanged.");
  }
  // The precondition above is not an install failure; everything below is.
  // Download/verify/start failures arrive already structured; the rest is the backend.
  try {
  await installCore(dataDir, version, opts);
  return await withCoreClient(dataDir, version, async client => {
    const catalog = await client.call<Catalog>("/backends/llamacpp/catalog", { force: true }, { signal: opts.signal, timeoutMs: 60_000 });
    const selected = catalog.recommended ?? catalog.recommended_installed;
    if (!selected) throw new CoreUnavailableError({ stage: "backend", reasonCode: "no_backend", detail: "Atomic Core found no compatible inference backend for this computer" });
    const [tag, backend, extra] = selected.split("/");
    if (!tag || !backend || extra || /[\\]/.test(selected) || tag === ".." || backend === "..") throw new Error("Atomic Core returned an invalid backend selection.");
    const asset = catalog.releases?.find(r => r.tag === tag)?.variants.find(v => v.id === backend)?.asset;
    const installed = await installSelectedBackend(client, "llamacpp", { version: tag, backend, ...(asset ? { asset_name: asset } : {}) }, opts);
    const binaryName = process.platform === "win32" ? "llama-server.exe" : "llama-server";
    const binary = [join(installed.path, "build", "bin", binaryName), join(installed.path, "bin", binaryName), join(installed.path, binaryName)].find(existsSync);
    if (!binary) throw new Error("Atomic Core installed a backend without an executable.");
    const record: CoreBackend = { coreVersion: version, provider: "llamacpp", version: tag, backend, binary, installedAt: new Date().toISOString() };
    opts.signal?.throwIfAborted();
    writeCoreJson(join(coreVersionDir(dataDir, version), "backend.json"), record);
    // A model may have started on the active Core during the install.
    const activated = await activeCoreIdle(dataDir);
    if (activated) writeActiveVersion(dataDir, version);
    return { ok: true, tag: `Atomic Core ${version} · ${tag}`, activated };
  }, opts.signal);
  } catch (err) { throw toCoreUnavailable(err, "backend", opts.signal); }
  }, { waitMs: 0 });
}
