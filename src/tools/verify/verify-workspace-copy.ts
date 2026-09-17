/**
 * The throwaway copy `verify.run` works in.
 *
 * Verification executes things — test runners, servers, pages — and
 * what they write (caches, logs, a harness the model wrote to check its
 * own work) used to land in the deliverable. So a run happens in a copy
 * under the OS temp dir and the copy is deleted afterwards.
 *
 * macOS: `cp -c -R` (clonefile) — instant on APFS whatever the size, so
 * nothing is excluded. Elsewhere: a plain copy with `node_modules`,
 * `.git`, `dist`, `build`, `target`, `.venv` left out and symlinked into
 * the copy instead; a tree over 2 GB (those excluded) is not copied at
 * all — the run happens in place and the result says `isolated: false`.
 * On the copy path the symlinked `.git` is the real one: a command that
 * commits inside the copy commits for real.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  rm,
  symlink,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const VERIFY_COPY_EXCLUDED: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".venv",
]);

export const VERIFY_COPY_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export interface VerifyWorkspace {
  /** Where the run happens: the copy, or the working directory itself. */
  readonly dir: string;
  readonly isolated: boolean;
  readonly method: "clonefile" | "copy" | "in-place";
  cleanup(): Promise<void>;
}

export interface CreateWorkspaceOptions {
  platform?: NodeJS.Platform;
  tmpRoot?: string;
  maxBytes?: number;
  /** Test seam: the clone attempt. Resolves `true` when the clone is complete. */
  clone?: (src: string, dest: string) => Promise<boolean>;
}

function cloneWithCp(src: string, dest: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("cp", ["-c", "-R", src, dest], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** Byte size of the tree minus the excluded directories; stops early past `limit`. */
export async function measureTree(root: string, limit: number): Promise<number> {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!VERIFY_COPY_EXCLUDED.has(entry.name)) stack.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        total += (await lstat(join(dir, entry.name))).size;
      } catch {
        // Vanished mid-walk; not worth failing a measurement over.
      }
      if (total > limit) return total;
    }
  }
  return total;
}

/**
 * Copy `src` into `dest` (which must not exist), symlinking the
 * excluded directories — at any depth — back to their originals.
 */
export async function copyTreeWithExclusions(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      await symlink(await readlink(from), to);
    } else if (entry.isDirectory()) {
      if (VERIFY_COPY_EXCLUDED.has(entry.name)) {
        await symlink(from, to, "dir");
      } else {
        await copyTreeWithExclusions(from, to);
      }
    } else if (entry.isFile()) {
      await copyFile(from, to);
      const mode = (await lstat(from)).mode & 0o777;
      if (mode & 0o111) await chmod(to, mode);
    }
    // Sockets, FIFOs, devices: not part of a deliverable, skipped.
  }
}

/** Create the workspace for one run. Never throws for a copy that cannot be made — falls back to in place. */
export async function createVerifyWorkspace(
  workingDir: string,
  options: CreateWorkspaceOptions = {},
): Promise<VerifyWorkspace> {
  const platform = options.platform ?? process.platform;
  const dest = join(
    options.tmpRoot ?? tmpdir(),
    `atag-verify-${randomBytes(4).toString("hex")}`,
  );
  const cleanup = async (): Promise<void> => {
    await rm(dest, { recursive: true, force: true });
  };
  if (platform === "darwin") {
    const cloned = await (options.clone ?? cloneWithCp)(workingDir, dest);
    if (cloned) return { dir: dest, isolated: true, method: "clonefile", cleanup };
    await cleanup();
  }
  const limit = options.maxBytes ?? VERIFY_COPY_MAX_BYTES;
  if ((await measureTree(workingDir, limit)) > limit) {
    return { dir: workingDir, isolated: false, method: "in-place", cleanup: async () => {} };
  }
  try {
    await copyTreeWithExclusions(workingDir, dest);
  } catch {
    await cleanup();
    return { dir: workingDir, isolated: false, method: "in-place", cleanup: async () => {} };
  }
  return { dir: dest, isolated: true, method: "copy", cleanup };
}
