import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { CoreControlClient } from "./core-client.js";
import { activeCoreVersion, coreSessionPath, readCoreJson, type CoreSessionRecord } from "./core-state.js";
import { noteReleaseTimeout, RELEASE_WAIT_MS, waitForProcessRelease } from "../server/process-release.js";

/**
 * An older Core that this build no longer runs can still hold a model
 * session the agent loaded (`core/chat.json` or `core/embedding.json` names
 * it). Its llama-server keeps the configured port, so the active Core and
 * the agent fight over port and key. Unload exactly those recorded sessions
 * through the Core that owns them, then drop their records, so the idle
 * check can retire that Core.
 *
 * Conservative: a record is ours only when it names this Core version and
 * instance, and the live session still matches its pid, generation, port
 * and model path. Sessions of other clients are never touched, nor is a
 * record of the version that is still active (image generation starts this
 * build's Core beside an older active one that serves chat). Best effort:
 * a refused unload keeps the record. The caller holds the engine operation
 * lock.
 */
export async function unloadRetiredCoreSessions(dataDir: string, client: CoreControlClient, releaseWaitMs = RELEASE_WAIT_MS): Promise<void> {
  if (activeCoreVersion(dataDir) === client.version) return;
  let snapshot: Awaited<ReturnType<CoreControlClient["snapshot"]>> | null = null;
  for (const role of ["chat", "embedding"] as const) {
    const path = coreSessionPath(dataDir, role);
    const record = readCoreJson<CoreSessionRecord>(path);
    if (!record || record.coreVersion !== client.version || record.instanceId !== client.instanceId) continue;
    snapshot ??= await client.snapshot();
    const session = snapshot.sessions.find(s => s.provider === record.provider && s.model_id === record.model_id &&
      s.pid === record.pid && s.port === record.port && s.model_path === record.model_path && s.generation === record.generation);
    if (!session) continue;
    const result = await client.call<{ success: boolean }>(`/models/${record.provider}/${encodeURIComponent(record.model_id)}/unload`, {}, { timeoutMs: 30_000 })
      .catch(() => ({ success: false }));
    if (!result.success) continue;
    // Windows: the unload can answer before the old llama-server has freed the
    // port the load that follows wants (ATO-304). Bounded; a timeout is noted.
    if (process.platform === "win32") {
      const released = await waitForProcessRelease(record.pid, record.port, { timeoutMs: releaseWaitMs });
      noteReleaseTimeout(join(dataDir, role === "embedding" ? "llama-embed.log" : "llama-server.log"), record.pid, record.port, released);
    }
    const pidPath = join(dataDir, role === "chat" ? "llama-server.pid" : "llama-embed.pid");
    try { if (readFileSync(pidPath, "utf8").trim() === String(record.pid)) unlinkSync(pidPath); } catch { /* no legacy mirror */ }
    try { unlinkSync(path); } catch { /* already gone */ }
  }
}
