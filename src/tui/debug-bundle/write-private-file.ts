import { chmod, writeFile } from "node:fs/promises";

/**
 * Owner-only mode for archives that carry traces. Traces hold prompts and
 * tool output verbatim, so the zips built from them get the same 0600 the
 * trace files themselves have (ATO-760, ATO-1179) instead of the umask's
 * usual 0644 that lets any other account on the machine read them.
 */
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Write `data` to `path` readable by the owner only. `mode` on
 * `writeFile` applies only when the file is created, so an existing file
 * is narrowed with an explicit chmod as well. On Windows POSIX modes are
 * ignored and the folder's ACL applies, so a failing chmod is not fatal.
 */
export async function writePrivateFile(
  path: string,
  data: Uint8Array | string,
): Promise<void> {
  await writeFile(path, data, { mode: PRIVATE_FILE_MODE });
  try {
    await chmod(path, PRIVATE_FILE_MODE);
  } catch {
    // Windows or a filesystem without POSIX modes.
  }
}
