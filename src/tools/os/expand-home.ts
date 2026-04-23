import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Expand a leading `~` in a path to the current user's home directory.
 *
 * Supported forms (macOS/Linux only — Windows is out of scope):
 *   - `~`            → `os.homedir()`
 *   - `~/foo/bar`    → `os.homedir()/foo/bar`
 *
 * Any other path (absolute, relative, or starting with `~user`) is returned
 * unchanged. `~user`-style expansion would require a passwd lookup and is
 * intentionally not supported.
 *
 * Non-string inputs and the empty string are returned unchanged so callers
 * can keep their own validation logic in one place.
 */
export function expandHome(path: string): string {
  if (typeof path !== "string" || path.length === 0) return path;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Resolve a user-supplied path to an absolute path:
 *   1. Expand a leading `~` to the home directory (see `expandHome`).
 *   2. If the result is already absolute, return it as-is.
 *   3. Otherwise, resolve it against `workingDir`.
 *
 * This is the canonical entry point for every `os.*` tool that accepts a
 * path argument — it keeps tilde handling consistent across the codebase.
 */
export function resolveUserPath(input: string, workingDir: string): string {
  const expanded = expandHome(input);
  return isAbsolute(expanded) ? expanded : resolve(workingDir, expanded);
}
