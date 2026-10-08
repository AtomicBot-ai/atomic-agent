import { withCoreOperation } from "./core-operation.js";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coreSessionPath, readCoreBackend, readCoreJson, writeCoreJson, type CoreSession, type CoreSessionRecord } from "./core-state.js";
import { connectCore, withCoreClient } from "./core-client.js";

/** These host arguments are owned by the control contract, never duplicated in extra_args. */
export function coreLoadOverrides(args: readonly string[]): Record<string, unknown> {
  const skipped = new Set(["-m", "--model", "--host", "--port", "-a", "--alias", "--mmproj"]);
  const extras: string[] = [];
  let ctx = 0;
  let parallel = 1;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (skipped.has(arg)) { i++; continue; }
    if (arg === "--ctx-size") ctx = Number(args[i + 1]);
    if (arg === "--parallel") parallel = Number(args[i + 1]);
    // Core's extra-argument parser understands double-quoted values, not a shell.
    extras.push(`"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  }
  extras.push("--slots");
  return { ctx_size: ctx, parallel, concurrent_mode: false, auto_unload: false,
    mtp: false, dflash: false, extra_args: extras.join(" ") };
}

export async function loadCoreSession(dataDir: string, options: {
  role: "chat" | "embedding";
  modelId: string;
  modelPath: string;
  port: number;
  args: readonly string[];
  mmprojPath?: string;
  signal?: AbortSignal;
}): Promise<CoreSession> {
  return withCoreOperation(dataDir, async () => {
  const backend = readCoreBackend(dataDir);
  if (!backend) throw new Error("Atomic Core backend is not installed. Choose Update engine first.");
  return withCoreClient(dataDir, backend.coreVersion, async client => {
    const path = `/models/${backend.provider}/${encodeURIComponent(options.modelId)}`;
    const before = (await client.snapshot()).sessions.find(s => s.provider === backend.provider && s.model_id === options.modelId);
    const cancel = () => { void client.call(`${path}/load/cancel`, {}).catch(() => {}); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      options.signal?.throwIfAborted();
      const result = await client.call<{ session: CoreSession; created: boolean }>(`${path}/load`, {
        modelPath: options.modelPath,
        ...(options.mmprojPath ? { mmprojPath: options.mmprojPath } : {}),
        port: options.port,
        isEmbedding: options.role === "embedding",
        bypassAutoUnload: true,
        timeoutSecs: 180,
        logPath: join(dataDir, options.role === "embedding" ? "llama-embed.log" : "llama-server.log"),
        overrides: { ...coreLoadOverrides(options.args), version_backend: `${backend.version}/${backend.backend}` },
      }, { timeoutMs: 240_000 });
      options.signal?.throwIfAborted();
      const s = result.session;
      if (!Number.isInteger(s.pid) || s.pid <= 0 || s.port !== options.port || s.model_id !== options.modelId || s.model_path !== options.modelPath || s.is_embedding !== (options.role === "embedding") || typeof s.api_key !== "string" || !s.api_key) {
        throw new Error("Atomic Core returned a model session that does not match the requested engine.");
      }
      const record: CoreSessionRecord = { ...s, provider: backend.provider, coreVersion: backend.coreVersion, instanceId: client.instanceId };
      writeCoreJson(coreSessionPath(dataDir, options.role), record);
      return s;
    } catch (err) {
      // Keep the request alive until Core answers cancellation: aborting only the
      // HTTP socket can leave a load that has already become ready untracked.
      await client.call(`${path}/load/cancel`, {}).catch(() => {});
      if (!before) {
        const live = (await client.snapshot()).sessions.find(s => s.provider === backend.provider && s.model_id === options.modelId && s.model_path === options.modelPath && s.port === options.port);
        if (live) {
          // Persist before cleanup so an unsuccessful unload remains recoverable.
          writeCoreJson(coreSessionPath(dataDir, options.role), { ...live, coreVersion: backend.coreVersion, instanceId: client.instanceId });
          const stopped = await client.call<{ success: boolean }>(`${path}/unload`, {}, { timeoutMs: 30_000 });
          if (stopped.success) unlinkSync(coreSessionPath(dataDir, options.role));
          else throw new Error("Model startup was interrupted; Core could not stop the model. Retry Stop models.");
        }
      }
      throw err;
    } finally { options.signal?.removeEventListener("abort", cancel); }
  }, options.signal);
  });
}

/** Return true even for a stale record: falling through to kill(pid) would bypass Core ownership. */
export async function stopCoreSession(dataDir: string, role: "chat" | "embedding"): Promise<boolean> {
  return withCoreOperation(dataDir, async () => {
  const path = coreSessionPath(dataDir, role);
  const record = readCoreJson<CoreSessionRecord>(path);
  if (!record) return false;
  const client = await connectCore(dataDir, record.coreVersion);
  if (!client) {
    let alive = true;
    try { process.kill(record.pid, 0); } catch (err) { alive = (err as NodeJS.ErrnoException).code !== "ESRCH"; }
    if (alive) throw new Error("Atomic Core is unavailable while its model is still running. Reconnect before stopping it.");
  }
  if (client) {
    const snapshot = await client.snapshot();
    const session = snapshot.sessions.find(s => s.provider === record.provider && s.model_id === record.model_id);
    if (session) {
      if (snapshot.instance_id !== record.instanceId || session.pid !== record.pid ||
          session.generation !== record.generation || session.model_path !== record.model_path) {
        throw new Error("The Core session changed. Refresh engine status before stopping it.");
      }
      const result = await client.call<{ success: boolean; error?: string }>(`/models/${record.provider}/${encodeURIComponent(record.model_id)}/unload`, {}, { timeoutMs: 30_000 });
      if (!result.success) throw new Error(result.error ?? "Atomic Core could not stop the model.");
    }
  }
  const pidPath = join(dataDir, role === "chat" ? "llama-server.pid" : "llama-embed.pid");
  try { if (readFileSync(pidPath, "utf8").trim() === String(record.pid)) unlinkSync(pidPath); } catch { /* no legacy mirror */ }
  unlinkSync(path);
  return true;
  });
}

export async function coreSessionStatus(dataDir: string, role: "chat" | "embedding"): Promise<CoreSession | null> {
  const record = readCoreJson<CoreSessionRecord>(coreSessionPath(dataDir, role));
  if (!record) return null;
  const client = await connectCore(dataDir, record.coreVersion);
  if (!client) return null;
  const snapshot = await client.snapshot();
  const session = snapshot.sessions.find(s => s.provider === record.provider && s.model_id === record.model_id && s.port === record.port && s.model_path === record.model_path);
  if (!session) return null;
  if (session.pid !== record.pid || session.generation !== record.generation || client.instanceId !== record.instanceId) {
    // A status poll must not contend with a long install/load. Only a changed
    // owner needs a short, guarded refresh; the next poll can retry it.
    await withCoreOperation(dataDir, async () => {
      const current = readCoreJson<CoreSessionRecord>(coreSessionPath(dataDir, role));
      if (current?.instanceId !== record.instanceId || current?.generation !== record.generation) return;
      writeCoreJson(coreSessionPath(dataDir, role), { ...session, coreVersion: client.version, instanceId: client.instanceId });
      writeFileSync(join(dataDir, role === "chat" ? "llama-server.pid" : "llama-embed.pid"), String(session.pid), { mode: 0o600 });
    }).catch(() => {});
  }
  return session;
}
