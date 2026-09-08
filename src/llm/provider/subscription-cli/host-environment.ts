import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

/**
 * Every fact about the host the Windows shim depends on, behind one
 * seam.
 *
 * The point is testability: nobody working on this has a Windows box, so
 * the win32 branch has to be reachable from a macOS/Linux run. Passing
 * `platform` / `env` / `fileExists` explicitly covers the shim's own
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

export function hostFileExists(path: string): boolean {
  return existsSync(path);
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
    return buffer.subarray(0, read).toString("latin1");
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
