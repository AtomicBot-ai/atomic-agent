import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { coreRoot } from "./core-state.js";

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
    throw new Error(ownerIsDead(gate)
      ? `Engine recovery was interrupted. With Agent closed, remove ${gate} and retry.`
      : "Another engine operation is starting. Retry shortly.");
  }
  let fd: number;
  try {
    writeFileSync(gateFd, String(process.pid));
    try { fd = openSync(path, "wx", 0o600); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (!ownerIsDead(path)) throw new Error("Another engine operation is running. Wait for it to finish.");
      // No other process can acquire/reclaim path while this gate is held.
      unlinkSync(path);
      fd = openSync(path, "wx", 0o600);
    }
    writeFileSync(fd, String(process.pid));
  } finally { closeSync(gateFd); unlinkSync(gate); }
  return () => { closeSync(fd); unlinkSync(path); };
}

/** Serialize mutations across CLI, TUI and desktop; never steal a live owner's lock. */
export async function withCoreOperation<T>(dataDir: string, operation: () => Promise<T>): Promise<T> {
  const release = acquire(dataDir);
  try { return await operation(); } finally { release(); }
}
