import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { coreSessionPath, readCoreJson, type CoreSessionRecord } from "./core-state.js";

/**
 * Reading a Core session record (`core/chat.json`, `core/embedding.json`)
 * that is there but did not read (ATO-2460).
 *
 * The record is written whole (`writeCoreJson`: temp file, then rename), so
 * a reader never sees half of it. On Windows, though, a file being replaced
 * by a rename, or held by an antivirus scan, can refuse a reader for a
 * moment (EPERM, EBUSY, EACCES). `readCoreJson` swallows that as "no
 * record", and a 401 from Core's own server then went unrefreshed and was
 * read as another program on the port.
 */

/** How many more reads a record that is there but did not read gets. */
export const CORE_RECORD_READ_RETRIES = 3;
/** The pause before each of those reads. */
export const CORE_RECORD_READ_RETRY_MS = 50;

/**
 * The record at `path`, read again a few times when the file exists but
 * did not read; `null` when it is not there or never reads. Same retry
 * shape as graceful-fs's Windows read and rename retries.
 */
export async function readCoreRecordSettled(
  path: string,
  pause: (ms: number) => Promise<unknown> = delay,
): Promise<CoreSessionRecord | null> {
  for (let attempt = 0; ; attempt += 1) {
    const record = readCoreJson<CoreSessionRecord>(path);
    if (record) return record;
    if (attempt >= CORE_RECORD_READ_RETRIES || !existsSync(path)) return null;
    await pause(CORE_RECORD_READ_RETRY_MS);
  }
}

/** Whether `pid` names a live process (EPERM: alive, someone else's). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a Core session record of ours claims loopback `port`. Read only,
 * sync, for judging a 401: Core's own model server on that port is then the
 * likely one that answered, not another program.
 *
 * - A record that is there and cannot be read claims it (it may well name
 *   the port): the ATO-2460 case.
 * - A readable record claims it only when it names the port, its server's
 *   pid is alive and Core has not already unloaded it (`awaitingExit`). A
 *   dead pid is not ours answering: the 401 already went through the key
 *   refresh, which reads Core's live session, so a live session on that
 *   port would have given the current key. Another program it stays
 *   (ATO-1277, ATO-1732).
 */
export function coreRecordClaimsPort(
  dataDir: string,
  port: number,
  alive: (pid: number) => boolean = pidAlive,
): boolean {
  for (const role of ["chat", "embedding"] as const) {
    const path = coreSessionPath(dataDir, role);
    if (!existsSync(path)) continue;
    const record = readCoreJson<Partial<CoreSessionRecord>>(path);
    if (record === null || typeof record !== "object") return true;
    if (record.port !== port) continue;
    if ((record as { awaitingExit?: unknown }).awaitingExit === true) continue;
    if (typeof record.pid === "number" && record.pid > 0 && alive(record.pid)) return true;
  }
  return false;
}
