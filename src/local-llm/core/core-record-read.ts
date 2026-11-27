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

/**
 * Whether a Core session record of ours claims loopback `port`: a record
 * that names it, or one that is there and cannot be read (it may well name
 * it). Read only, sync, for judging a 401: Core's own model server on that
 * port is then the likely one that answered, not another program.
 */
export function coreRecordClaimsPort(dataDir: string, port: number): boolean {
  for (const role of ["chat", "embedding"] as const) {
    const path = coreSessionPath(dataDir, role);
    if (!existsSync(path)) continue;
    const record = readCoreJson<Partial<CoreSessionRecord>>(path);
    if (record === null || typeof record !== "object") return true;
    if (record.port === port) return true;
  }
  return false;
}
