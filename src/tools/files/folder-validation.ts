import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

import { FolderRejectedError } from "./file-index-types.js";

/**
 * Whether a folder may go into the index, and its canonical path.
 * Checked in this order, each with its own error code:
 *
 *   - `not_absolute`: empty, or not an absolute path (`~` is not expanded:
 *     the desktop sends the path its folder picker returned);
 *   - `too_broad`: the disk root, the home folder itself, a system folder
 *     or anything inside one, or the agent's own state folder;
 *   - `not_found` / `not_a_directory`;
 *   - `already_added`: the same folder, after symlinks are resolved;
 *   - `inside_added`: a folder already added contains it.
 *
 * A folder that contains added ones is accepted: the index takes the
 * inner folders into it (`FileIndexStore.addFolder`).
 */
export interface FolderValidationOptions {
  /** Default: the OS home folder. */
  home?: string;
  /** Folders refused like system ones, with what is inside them (the agent's state dir). */
  protectedDirs?: readonly string[];
  /** Default: the platform's system folders. A test seam (temp folders live under `/var` on macOS). */
  systemDirs?: readonly string[];
  platform?: NodeJS.Platform;
}

const POSIX_SYSTEM_DIRS = [
  "/System",
  "/Library",
  "/Applications",
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
  "/var",
  "/private",
  "/dev",
  "/opt",
  "/proc",
  "/sys",
  "/boot",
  "/cores",
];

/** Refused themselves, not what is inside them: every person's home sits there. */
const POSIX_HOMES_ROOTS = ["/Users", "/home"];

const WINDOWS_SYSTEM_DIRS = ["Windows", "Program Files", "Program Files (x86)", "ProgramData"];

/** Resolve and check `raw`; returns the real path to store. */
export async function validateFolder(
  raw: unknown,
  addedFolders: readonly string[],
  options: FolderValidationOptions = {},
): Promise<string> {
  if (typeof raw !== "string" || raw.trim().length === 0 || !isAbsolute(raw)) {
    throw new FolderRejectedError("not_absolute", "pass the folder as an absolute path");
  }
  const requested = resolve(raw);
  rejectTooBroad(requested, options);
  let info;
  try {
    info = await stat(requested);
  } catch {
    throw new FolderRejectedError("not_found", `${requested} does not exist`);
  }
  if (!info.isDirectory()) {
    throw new FolderRejectedError("not_a_directory", `${requested} is not a folder`);
  }
  const real = await realpath(requested);
  // `/etc` is `/private/etc` on macOS: the real path is checked as well.
  rejectTooBroad(real, options);
  for (const added of addedFolders) {
    if (samePath(added, real, options.platform)) {
      throw new FolderRejectedError("already_added", `${real} is already in My files`);
    }
  }
  for (const added of addedFolders) {
    if (isInside(real, added, options.platform)) {
      throw new FolderRejectedError("inside_added", `${real} is inside ${added}, which is already in My files`);
    }
  }
  return real;
}

function rejectTooBroad(path: string, options: FolderValidationOptions): void {
  const platform = options.platform ?? process.platform;
  const home = resolve(options.home ?? homedir());
  const root = parse(path).root;
  const broad = [root, home, ...(platform === "win32" ? [resolve(root, "Users")] : POSIX_HOMES_ROOTS)];
  if (broad.some((dir) => samePath(path, dir, platform))) {
    throw new FolderRejectedError("too_broad", `${path} is too broad; pick a folder inside it`);
  }
  const system =
    options.systemDirs ??
    (platform === "win32" ? WINDOWS_SYSTEM_DIRS.map((name) => resolve(root, name)) : POSIX_SYSTEM_DIRS);
  for (const dir of [...system, ...(options.protectedDirs ?? [])]) {
    if (samePath(path, dir, platform) || isInside(path, dir, platform)) {
      throw new FolderRejectedError("too_broad", `${path} is a system or app folder and cannot be indexed`);
    }
  }
}

/** Whether `path` is strictly inside `dir`. */
export function isInside(path: string, dir: string, platform?: NodeJS.Platform): boolean {
  const rel = relative(norm(dir, platform), norm(path, platform));
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

function samePath(a: string, b: string, platform?: NodeJS.Platform): boolean {
  return norm(a, platform) === norm(b, platform);
}

/** macOS and Windows file systems are case-insensitive by default. */
function norm(path: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = resolve(path);
  return platform === "darwin" || platform === "win32" ? resolved.toLowerCase() : resolved;
}
