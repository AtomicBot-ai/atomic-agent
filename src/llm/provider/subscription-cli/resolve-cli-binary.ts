import { existsSync } from "node:fs";
import { win32 } from "node:path";

/**
 * Pick the command to spawn for a vendor CLI.
 *
 * A configured `binPath` always wins — that is the escape hatch for a
 * binary outside `PATH`. Otherwise we hand the bare name to `spawn`,
 * which resolves it through `PATH` itself, except on Windows: with
 * `shell: false` Node will not try the `PATHEXT` suffixes, so
 * `spawn("claude")` misses the `claude.cmd` shim npm installs. There we
 * walk `PATH` ourselves and return the first suffixed hit.
 */
export function resolveCliBinary(
  defaultBinary: string,
  binPath?: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): string {
  if (binPath && binPath.length > 0) return binPath;
  if (platform !== "win32") return defaultBinary;
  if (win32.isAbsolute(defaultBinary)) return defaultBinary;

  const suffixes = [".cmd", ".exe", ".bat", ""];
  // Windows path semantics regardless of the host we are running on,
  // so the branch is testable from macOS/Linux.
  for (const dir of (env.PATH ?? "").split(";")) {
    if (dir.length === 0) continue;
    for (const suffix of suffixes) {
      const candidate = win32.join(dir, `${defaultBinary}${suffix}`);
      if (fileExists(candidate)) return candidate;
    }
  }
  // Nothing on PATH — hand back the bare name so the ENOENT surfaces
  // from spawn with the standard not-installed message.
  return defaultBinary;
}
