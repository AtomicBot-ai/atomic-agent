import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function isWithinWorkspace(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

/** No special files, unbounded reads, or symlinks escaping the permitted root. */
export function readWorkspaceFile(root: string, path: string, maxBytes = 1024 * 1024): { path: string; content: string } | null {
  let actual: string;
  try { actual = realpathSync(resolve(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!isWithinWorkspace(root, actual)) throw new Error(`File is outside workspace: ${path}`);
  if (!statSync(actual).isFile()) throw new Error(`Expected a regular file: ${path}`);
  const fd = openSync(actual, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) throw new Error(`Workspace file exceeds ${maxBytes} bytes or is not regular: ${path}`);
    const buffer = Buffer.alloc(Math.min(maxBytes, info.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > info.size || length > maxBytes || realpathSync(path) !== actual) throw new Error(`Workspace file changed while reading or exceeds ${maxBytes} bytes: ${path}`);
    const content = buffer.subarray(0, length).toString("utf8");
    return { path: actual, content };
  } finally { closeSync(fd); }
}

export interface StatSnapshot {
  /** Stat signature of every path, in order; a missing path is "-". */
  signature: string;
  /** Latest modification time among the paths, in ms; 0 when none exist. */
  newest: number;
}

/**
 * What a cache compares to decide whether files it read are unchanged:
 * mtime, ctime and size per path (following symlinks), without reading contents.
 */
export function statSnapshot(paths: readonly string[]): StatSnapshot {
  let newest = 0;
  const signature = paths.map(path => {
    try {
      const info = statSync(path, { throwIfNoEntry: false });
      if (!info) return "-";
      newest = Math.max(newest, info.mtimeMs);
      return `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    } catch (error) { return `!${(error as NodeJS.ErrnoException).code ?? ""}`; }
  }).join("|");
  return { signature, newest };
}
