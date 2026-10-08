import { withCoreOperation } from "./core-operation.js";
import { connectCore } from "./core-client.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DownloadFileOptions } from "../downloads/download-file.js";
import { CORE_VERSION, activeCoreVersion, coreRoot, coreVersionDir, readCoreBackend, writeCoreJson, type CoreBackend } from "./core-state.js";
import { withCoreClient } from "./core-client.js";
import { installCore, isCoreInstalled } from "./core-install.js";

interface Catalog {
  recommended: string | null;
  recommended_installed: string | null;
  releases?: Array<{ tag: string; variants: Array<{ id: string; asset?: string }> }>;
}

export function isCoreBackendInstalled(dataDir: string): boolean {
  return isCoreInstalled(dataDir) && readCoreBackend(dataDir) !== null;
}

/** Core owns platform/hardware selection and backend acquisition, as in Atomic Chat. */
export async function installCoreBackend(dataDir: string, opts: DownloadFileOptions = {}, version = CORE_VERSION): Promise<{ ok: true; tag: string }> {
  return withCoreOperation(dataDir, async () => {
  const current = await connectCore(dataDir, activeCoreVersion(dataDir));
  if (current && (await current.snapshot()).sessions.length > 0) {
    throw new Error("Stop local models before updating the engine. Your running models are unchanged.");
  }
  await installCore(dataDir, version, opts);
  return withCoreClient(dataDir, version, async client => {
    const catalog = await client.call<Catalog>("/backends/llamacpp/catalog", { force: true }, { signal: opts.signal, timeoutMs: 60_000 });
    const selected = catalog.recommended ?? catalog.recommended_installed;
    if (!selected) throw new Error("Atomic Core found no compatible inference backend for this computer.");
    const [tag, backend, extra] = selected.split("/");
    if (!tag || !backend || extra || /[\\]/.test(selected) || tag === ".." || backend === "..") throw new Error("Atomic Core returned an invalid backend selection.");
    const asset = catalog.releases?.find(r => r.tag === tag)?.variants.find(v => v.id === backend)?.asset;
    const taskId = `agent-backend-${randomUUID()}`;
    const cancel = () => { void client.call(`/downloads/${taskId}/cancel`, {}).catch(() => {}); };
    const stopEvents = await client.downloadEvents(taskId, opts.onProgress ?? (() => {}), opts.signal);
    opts.signal?.addEventListener("abort", cancel, { once: true });
    opts.onProgress?.(0, 0, 0);
    let installed: { path: string };
    try {
      installed = await client.call<{ path: string }>("/backends/llamacpp/install", { version: tag, backend, task_id: taskId, ...(asset ? { asset_name: asset } : {}) }, { signal: opts.signal, timeoutMs: 15 * 60_000 });
    } finally { opts.signal?.removeEventListener("abort", cancel); await stopEvents(); }
    const binaryName = process.platform === "win32" ? "llama-server.exe" : "llama-server";
    const binary = [join(installed.path, "build", "bin", binaryName), join(installed.path, "bin", binaryName), join(installed.path, binaryName)].find(existsSync);
    if (!binary) throw new Error("Atomic Core installed a backend without an executable.");
    const record: CoreBackend = { coreVersion: version, provider: "llamacpp", version: tag, backend, binary, installedAt: new Date().toISOString() };
    opts.signal?.throwIfAborted();
    writeCoreJson(join(coreVersionDir(dataDir, version), "backend.json"), record);
    const previous = activeCoreVersion(dataDir);
    writeCoreJson(join(coreRoot(dataDir), "active.json"), { version, previous });
    return { ok: true, tag: `Atomic Core ${version} · ${tag}` };
  }, opts.signal);
  });
}
