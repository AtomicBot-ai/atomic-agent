import { chmodSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

/** Owner read/write only: the mode `config.json` and `.env` are kept at. */
export const OWNER_ONLY_FILE_MODE = 0o600;

/**
 * Atomically replace `path` with `payload`, readable and writable by its
 * owner only: a tmp file created 0600 beside it, then renamed over it.
 *
 * `config.json` was written with the default mode (0644 under the usual
 * umask), so any other account on the machine could read it, and with it
 * whatever the operator keeps there: MCP server env blocks and headers,
 * hand-set provider headers, provider keys written inline. `.env` has
 * always been 0600 (`setDotenvKey`); this gives the config the same mode
 * on every write, so a file that was 0644 is tightened the next time
 * anything saves it.
 *
 * The tmp file is created exclusively, after removing one a crash may
 * have left: a leftover keeps the mode it was created with, and writing
 * into it would put the new content on disk at that mode until the
 * rename. Windows has no POSIX modes; there the chmod is a no-op and the
 * file keeps its folder's ACL.
 */
export function writeOwnerOnlyFileAtomicSync(
  path: string,
  payload: string,
): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    unlinkSync(tmp);
  } catch {
    // none left behind — the usual case
  }
  writeFileSync(tmp, payload, {
    encoding: "utf8",
    mode: OWNER_ONLY_FILE_MODE,
    flag: "wx",
  });
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best effort cleanup
    }
    throw err;
  }
  // Creation masks the mode with the umask, which only ever removes bits;
  // chmod again so the result does not depend on the platform keeping it.
  try {
    chmodSync(path, OWNER_ONLY_FILE_MODE);
  } catch {
    // Windows: no POSIX modes. The rename already won.
  }
}
