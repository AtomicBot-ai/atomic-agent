import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { coreRoot } from "./core-state.js";

/**
 * How long start, stop and engine selection wait for another frontend's
 * engine operation (a TUI model load, a desktop stop) before giving up.
 * An install never waits: it is exclusive and says so at once.
 */
export const CORE_OPERATION_WAIT_MS = 30_000;
const CORE_OPERATION_POLL_MS = 250;

/** Another live process holds the engine operation lock: worth waiting for. */
class CoreOperationBusyError extends Error {
  override readonly name = "CoreOperationBusyError";
}

function ownerIsDead(path: string): boolean {
  let pid: number;
  try { pid = Number(readFileSync(path, "utf8")); } catch { return false; }
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return false; }
  catch (err) { return (err as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** All acquisitions and stale recovery pass through a synchronous exclusive gate. */
function acquire(dataDir: string): () => void {
  mkdirSync(coreRoot(dataDir), { recursive: true, mode: 0o700 });
  const path = join(coreRoot(dataDir), "operation.lock");
  const gate = join(coreRoot(dataDir), "operation-gate.lock");
  let gateFd: number;
  try { gateFd = openSync(gate, "wx", 0o600); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    if (ownerIsDead(gate)) throw new Error(`Engine recovery was interrupted. With Agent closed, remove ${gate} and retry.`);
    throw new CoreOperationBusyError("Another engine operation is starting. Retry shortly.");
  }
  let fd: number;
  try {
    writeFileSync(gateFd, String(process.pid));
    try { fd = openSync(path, "wx", 0o600); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (!ownerIsDead(path)) throw new CoreOperationBusyError("Another engine operation is running. Wait for it to finish.");
      // No other process can acquire/reclaim path while this gate is held.
      unlinkSync(path);
      fd = openSync(path, "wx", 0o600);
    }
    writeFileSync(fd, String(process.pid));
  } finally { closeSync(gateFd); unlinkSync(gate); }
  return () => { closeSync(fd); unlinkSync(path); };
}

/**
 * Serialize mutations across CLI, TUI and desktop; never steal a live owner's
 * lock. While another live process holds it, poll for up to `waitMs`
 * (default CORE_OPERATION_WAIT_MS), so a desktop `models stop` during a TUI
 * load waits for the load instead of failing; `waitMs: 0` answers at once.
 */
export async function withCoreOperation<T>(dataDir: string, operation: () => Promise<T>, opts: { waitMs?: number } = {}): Promise<T> {
  const release = await acquireWithin(dataDir, Math.max(0, opts.waitMs ?? CORE_OPERATION_WAIT_MS));
  try { return await operation(); } finally { release(); }
}

async function acquireWithin(dataDir: string, waitMs: number): Promise<() => void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { return acquire(dataDir); }
    catch (err) {
      if (!(err instanceof CoreOperationBusyError) || Date.now() >= deadline) throw err;
      await delay(Math.min(CORE_OPERATION_POLL_MS, Math.max(1, deadline - Date.now())));
    }
  }
}
