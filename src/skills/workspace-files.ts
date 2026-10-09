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
