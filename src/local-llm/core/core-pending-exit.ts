import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { coreSessionPath, readCoreJson, writeCoreJson, type CoreSessionRecord } from "./core-state.js";
import { waitForProcessRelease, type ReleaseWaitResult } from "../server/process-release.js";

/**
 * A Core model server that was unloaded but has not exited yet (ATO-1748).
 *
 * On Windows Core's unload can answer before its llama-server has exited,
 * and the stop's release wait (ATO-304) is bounded. When that wait ran out,
 * the stop used to delete `core/<role>.json` anyway. The old server kept
 * answering on its port with the old session key, the next start could
 * take the same port, and every request then met that server and got 401
 * for a key nobody held any more.
 *
 * Now the record stays, marked `awaitingExit`, and a load on that port
 * first waits for the old server again. Nothing here signals the process:
 * Core owns its children (`reapThroughNewCore`), and an unloaded server
 * that is slow to exit is already on its way out.
 */

/** How long a load waits for an unloaded server still holding its port. */
export const PENDING_EXIT_WAIT_MS = 10_000;

type ReleaseWait = typeof waitForProcessRelease;

/** Remove the legacy pid mirror when it still names `pid`. */
function dropPidMirror(dataDir: string, role: "chat" | "embedding", pid: number): void {
  const path = join(dataDir, role === "chat" ? "llama-server.pid" : "llama-embed.pid");
  try { if (readFileSync(path, "utf8").trim() === String(pid)) unlinkSync(path); } catch { /* no legacy mirror */ }
}

/** Drop the record of an unloaded session, and its legacy pid mirror when it names the same pid. */
export function forgetCoreSession(dataDir: string, role: "chat" | "embedding", pid: number): void {
  dropPidMirror(dataDir, role, pid);
  try { unlinkSync(coreSessionPath(dataDir, role)); } catch { /* already gone */ }
}

/**
 * After an unload and its release wait: forget the session when its server
 * let go, else keep the record marked `awaitingExit` (the pid mirror goes
 * either way: the server is no longer a running engine).
 */
export function settleUnloadedSession(dataDir: string, role: "chat" | "embedding", record: CoreSessionRecord, released: ReleaseWaitResult): void {
  if (released.released) { forgetCoreSession(dataDir, role, record.pid); return; }
  dropPidMirror(dataDir, role, record.pid);
  writeCoreJson(coreSessionPath(dataDir, role), { ...record, awaitingExit: true });
}

/** Wait for one `awaitingExit` record's server again; forget it once it let go. True when it did. */
export async function settlePendingExit(dataDir: string, role: "chat" | "embedding", record: CoreSessionRecord, timeoutMs: number, wait: ReleaseWait = waitForProcessRelease): Promise<boolean> {
  const result = await wait(record.pid, record.port, { timeoutMs });
  if (!result.released) return false;
  forgetCoreSession(dataDir, role, record.pid);
  return true;
}

/**
 * Before a load on `port`: when an unloaded server of either role still
 * holds that port, wait for it (bounded) and forget its record. Throws a
 * plain sentence when it still holds the port, instead of starting a new
 * server beside it that our client could never reach with its new key.
 * The caller holds the engine operation lock.
 */
export async function waitForPendingExitOnPort(dataDir: string, port: number, timeoutMs = PENDING_EXIT_WAIT_MS, wait: ReleaseWait = waitForProcessRelease): Promise<void> {
  for (const role of ["chat", "embedding"] as const) {
    const record = readCoreJson<CoreSessionRecord>(coreSessionPath(dataDir, role));
    if (!record?.awaitingExit || record.port !== port) continue;
    if (await settlePendingExit(dataDir, role, record, timeoutMs, wait)) continue;
    throw new Error(`The previous model server (pid ${record.pid}) has not released port ${port} yet. Wait a few seconds and start again; if it stays, end that process, then retry.`);
  }
}
