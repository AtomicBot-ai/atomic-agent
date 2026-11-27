import type { CoreFailureReason } from "./core-errors.js";

/**
 * Windows STATUS_DLL_INIT_FAILED (0xC0000142): a DLL the binary needs
 * failed to initialise. Node reports it unsigned or, on some paths, as the
 * signed 32-bit value.
 */
const DLL_INIT_FAILED = new Set([0xC0000142, -1073741502]);

/** Spawn refused by the OS, usually antivirus quarantine or a lock on the file. */
const ACCESS_ERRNO = new Set(["EACCES", "EPERM"]);

/**
 * Why the downloaded Core binary would not answer `--version`, as a short
 * fixed word for `local_engine_failed` (ATO-1742). Reads only the error's
 * shape from `execFile` (`code`, `killed`), never its message or a path.
 *
 * - `spawn_dll_init`: exited with 0xC0000142 (a DLL failed to initialise).
 * - `spawn_access`: EACCES / EPERM (usually antivirus).
 * - `spawn_missing`: ENOENT (the file was removed right after download).
 * - `spawn_timeout`: killed by the execFile timeout.
 * - `spawn_exit`: any other exit code.
 * - `spawn`: anything else.
 */
export function coreSpawnReason(err: unknown): CoreFailureReason {
  if (!err || typeof err !== "object") return "spawn";
  const { code, killed } = err as { code?: unknown; killed?: unknown };
  if (typeof code === "string") {
    if (ACCESS_ERRNO.has(code)) return "spawn_access";
    if (code === "ENOENT") return "spawn_missing";
    return "spawn";
  }
  if (killed === true) return "spawn_timeout";
  if (typeof code === "number") return DLL_INIT_FAILED.has(code) ? "spawn_dll_init" : "spawn_exit";
  return "spawn";
}
