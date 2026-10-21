/**
 * ATO-507: the free space on the disk local models are downloaded to.
 *
 * A curated model is 5–26 GB, and a pull that runs out of room fails only
 * when the engine starts, after an hour of downloading (engine-failure.ts
 * "disk"). The window asks this before it offers a download, and says
 * "Needs 19.7 GB, 12.1 GB free on this disk." instead of starting one that
 * cannot finish.
 *
 * Models land in `<dataDir>/models/<id>/…` (agent-cli.ts modelIdFromPath,
 * the agent's src/local-llm/backend-paths.ts resolveModelDir). On a first
 * run that folder may not exist yet, so the nearest folder above it that
 * does is measured: it is on the same disk unless a mount sits in between,
 * which a folder that does not exist yet cannot be.
 *
 * Pure but for the file system reads: no Electron import, so the unit suite
 * can load it from `out/main`.
 */

import { statfs } from "node:fs/promises";
import { dirname, join } from "node:path";

/** What `app:diskSpace` answers. Null when the disk could not be read: the window then blocks nothing. */
export type DiskSpace = { freeBytes: number; totalBytes: number; path: string } | null;

/** The folder models are written to, under the managed data dir. */
export function modelsDirOf(dataDir: string): string {
  return join(dataDir, "models");
}

/**
 * Free and total bytes on the disk that holds `dir`, measured at `dir` or at
 * the nearest folder above it that exists. `path` is the folder measured.
 * Null when nothing on the way up could be read (or the numbers make no sense).
 */
export async function diskSpaceAt(dir: string, fs: { statfs: typeof statfs } = { statfs }): Promise<DiskSpace> {
  let at = dir;
  for (let hops = 0; hops < 64 && at; hops++) {
    try {
      const s = await fs.statfs(at);
      // bavail: the blocks an unprivileged writer (the agent) may use, not bfree.
      const freeBytes = Number(s.bavail) * Number(s.bsize);
      const totalBytes = Number(s.blocks) * Number(s.bsize);
      if (!Number.isFinite(freeBytes) || freeBytes < 0 || !Number.isFinite(totalBytes)) return null;
      return { freeBytes, totalBytes, path: at };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      const up = dirname(at);
      if (up === at) return null;
      at = up;
    }
  }
  return null;
}
