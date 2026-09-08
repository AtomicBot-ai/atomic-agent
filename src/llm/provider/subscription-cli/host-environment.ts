import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * Every fact about the host the Windows shim depends on, behind one
 * seam.
 *
 * The point is testability: nobody working on this has a Windows box, so
 * the win32 branch has to be reachable from a macOS/Linux run. Passing
 * `platform` / `env` / `fileStatus` explicitly covers the shim's own
 * unit tests, and mocking this module (`vi.mock("./host-environment.js")`)
 * covers the wiring — `streamCliCommand` and `runCliCommand` calling the
 * shim at all, which is otherwise invisible off Windows because the shim
 * is a passthrough everywhere else.
 */

export function hostPlatform(): NodeJS.Platform {
  return process.platform;
}

export function hostEnv(): NodeJS.ProcessEnv {
  return process.env;
}

/**
 * Three answers, not two.
 *
 * `existsSync` collapses "this path is not there" and "I was not allowed
 * to look" into the same `false`, and the second happens for real: a
 * `binPath` under a directory the user may traverse but not stat
 * (EACCES/EPERM), or on a UNC share that is momentarily unavailable
 * (ENETUNREACH, ETIMEDOUT, EBUSY). Reporting those as "not installed"
 * turns a working install into "was not found on PATH". Only ENOENT and
 * ENOTDIR — the path, or a directory along it, genuinely is not there —
 * are `absent`; everything else is `unknown` and the caller hands the
 * target to cmd.exe, which can answer for itself.
 */
export type FileStatus = "present" | "absent" | "unknown";

export function hostFileStatus(path: string): FileStatus {
  try {
    statSync(path);
    return "present";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unknown";
  }
}

/**
 * How much of a `.cmd`/`.bat` we are willing to read to decide how to
 * escape. npm's cmd-shim template is ~400 bytes and every generator in
 * the wild is in the same range; the cap is there so a `.cmd` that is
 * really a multi-megabyte blob cannot stall a turn.
 */
const SHIM_PROBE_BYTES = 8 * 1024;

/** Keyed on identity *and* mtime/size, so an npm update is not missed. */
const probeCache = new Map<string, string | null>();

/**
 * The first few KiB of a batch shim, or `null` when it cannot be read.
 *
 * `null` is a real answer, not an error: the caller has a conservative
 * default for "cannot tell", and a shim we may not read is not a reason
 * to fail a turn.
 *
 * "Cannot tell" includes *reading only part of the file*. A file that
 * fills the probe window may well substitute its arguments past the end
 * of what we looked at, and answering "no `%*` in the first 8 KiB" with
 * a confident `false` picks the weaker escaping for the one case we know
 * nothing about — the exact injection the gate exists to close. A
 * truncated read is therefore no answer at all.
 */
export function readShimHead(path: string): string | null {
  let key = path;
  try {
    const stat = statSync(path);
    key = `${path}|${stat.size}|${stat.mtimeMs}`;
  } catch {
    return null;
  }
  const cached = probeCache.get(key);
  if (cached !== undefined) return cached;

  const text = readHead(path);
  probeCache.set(key, text);
  return text;
}

function readHead(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(SHIM_PROBE_BYTES);
    const read = readSync(fd, buffer, 0, SHIM_PROBE_BYTES, 0);
    // Filled the window: there is more file than we read, so anything we
    // did not see is unknown rather than absent.
    if (read >= SHIM_PROBE_BYTES) return null;
    return decodeShim(buffer.subarray(0, read));
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // nothing useful to do with a failing close here
      }
    }
  }
}

/**
 * Batch files are bytes, not text, and cmd reads them in the console
 * codepage — so `latin1` (a byte-for-byte mapping that never fails) is
 * the right default: it cannot mangle the ASCII `%*` / `%1` we are
 * looking for, and a UTF-8 BOM is just three bytes of noise in front of
 * it.
 *
 * UTF-16 is the one encoding that would hide the token, since `%*`
 * becomes `%\0*\0`. cmd cannot reliably run a UTF-16LE batch file at all
 * (it reads the NULs as command text), so this is close to unreachable —
 * but decoding it costs one branch and removes the question. UTF-16BE
 * has no decoder here and no plausible reader either, so it is simply
 * "cannot tell".
 */
function decodeShim(bytes: Buffer): string | null {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return bytes.subarray(2).toString("utf16le");
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return null;
  }
  return bytes.toString("latin1");
}
