import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Expand a leading `~` in a path to the current user's home directory.
 *
 * Supported forms:
 *   - `~`            → `os.homedir()`
 *   - `~/foo/bar`    → `os.homedir()/foo/bar`
 *   - `~\foo\bar`    → `os.homedir()\foo\bar` (Windows)
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
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/**
 * Detect a POSIX-absolute path (leading single `/`) on Windows. Node's
 * `path.isAbsolute("/tmp")` returns `true` on Windows and `path.resolve`
 * would silently rebase it onto the current drive (`C:\tmp`), writing to a
 * location the caller never meant. Drive-qualified (`C:\`, `C:/`) and UNC
 * (`\\server`, `//server`) paths are genuine Windows absolutes and pass.
 */
function isPosixAbsoluteOnWindows(p: string): boolean {
  if (process.platform !== "win32") return false;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return false; // drive-qualified
  if (/^[\\/]{2}/.test(p)) return false; // UNC
  return p.startsWith("/");
}

/**
 * Resolve a user-supplied path to an absolute path:
 *   1. Expand a leading `~` to the home directory (see `expandHome`).
 *   2. If the result is already absolute, return it as-is.
 *   3. Otherwise, resolve it against `workingDir`.
 *
 * On Windows a POSIX-absolute path (`/tmp`, `/usr/...`) throws instead of
 * being silently rebased onto the current drive — the model must use a
 * Windows path (`C:\...`) or a relative path.
 *
 * This is the canonical entry point for every `os.*` tool that accepts a
 * path argument — it keeps tilde handling consistent across the codebase.
 */
export function resolveUserPath(input: string, workingDir: string): string {
  const expanded = expandHome(input);
  if (isPosixAbsoluteOnWindows(expanded)) {
    throw new Error(
      `Unix-absolute path "${input}" is ambiguous on Windows. Use a Windows path (e.g. "C:\\Users\\...") or a path relative to the working directory.`,
    );
  }
  return isAbsolute(expanded) ? expanded : resolve(workingDir, expanded);
}
