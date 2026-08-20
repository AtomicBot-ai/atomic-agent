import { execSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import JSZip from "jszip";

/**
 * Filesystem side of a backend install: unpack an archive into a
 * staging directory, normalise the layout, and swap it over the live
 * one only once it is complete and usable.
 *
 * Kept separate from `backend-installer.ts` so the release-resolution
 * logic there is not interleaved with extraction mechanics.
 */

function normalizeZipPath(entryName: string): string {
  return entryName.replace(/\\/g, "/");
}

/**
 * Recursively walk `root`, return the absolute path to the first file
 * whose basename equals `name`. Used after zip extraction to find the
 * `llama-server` binary regardless of the archive's internal nesting
 * (some releases wrap it under `build/bin/`, others under a single
 * top-level folder, others drop it at the root).
 */
function findFileByName(root: string, name: string): string | null {
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(cur, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (entry === name) {
        return full;
      }
    }
  }
  return null;
}

/**
 * Move every file in `from` (recursively) into `to`, flattening into
 * siblings at `to`'s root. Used to promote `backend/build/bin/*` or
 * `backend/release-root/*` up to `backend/` after extraction so the
 * `llama-server` binary lives at the path `resolveServerBinPath`
 * expects. Existing files at the destination are overwritten.
 */
function moveContentsFlat(from: string, to: string): void {
  const walk = (dir: string): void => {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const src = join(dir, entry);
      const st = statSync(src);
      if (st.isDirectory()) {
        walk(src);
        continue;
      }
      const dst = join(to, entry);
      mkdirSync(dirname(dst), { recursive: true });
      try {
        renameSync(src, dst);
      } catch {
        // Cross-device or other rename failure — fall back to copy+unlink.
        writeFileSync(dst, readFileSync(src));
        try {
          rmSync(src, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(from);
}

/**
 * Return the first path segment under `backendRoot` leading to
 * `fileInside` — e.g. for `backendRoot=/.../backend` and
 * `fileInside=/.../backend/build/bin/llama-server` this returns
 * `/.../backend/build`. Used after the flatten step to delete the
 * now-empty wrapper tree.
 */
function topLevelWrapper(backendRoot: string, fileInside: string): string | null {
  const rel = relative(backendRoot, fileInside);
  // `relative` yields platform-native separators: `/` on POSIX, `\` on
  // Windows. Match either so the wrapper dir is cleaned up on both.
  const firstSep = rel.search(/[/\\]/);
  if (firstSep < 0) return null;
  return join(backendRoot, rel.slice(0, firstSep));
}

/**
 * Remove `dir` if it exists, ignoring failures. Used for staging /
 * rollback scratch dirs where a leftover is a nuisance, not a fault.
 */
export function rmDirQuiet(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Is the staged tree a usable install? Guards the swap: only an
 * extraction that actually produced an executable server binary at the
 * path the daemon launches is allowed to replace a working one.
 */
function stagedBinaryUsable(binPath: string): boolean {
  try {
    const st = statSync(binPath);
    if (!st.isFile() || st.size === 0) return false;
  } catch {
    return false;
  }
  if (process.platform === "win32") return true;
  try {
    accessSync(binPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract `archivePath` into `stagingDir` and normalise the layout so
 * `binaryName` ends up at the staging root, executable. Throws when the
 * archive does not yield a usable server binary — the caller is
 * expected to discard the staging dir and keep the previous install.
 */
export async function extractBackendArchive(
  archivePath: string,
  stagingDir: string,
  binaryName: string,
): Promise<void> {
  const zip = await JSZip.loadAsync(readFileSync(archivePath));
  // Extract preserving the archive's internal layout. Flattening
  // happens in a second pass so we can support any of:
  //   * `llama-server` (flat)
  //   * `release-root/llama-server` (single top folder)
  //   * `build/bin/llama-server` (nested)
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const rel = normalizeZipPath(entry.name);
    if (!rel || rel.endsWith("/")) continue;
    const out = join(stagingDir, rel);
    mkdirSync(dirname(out), { recursive: true });
    const buf = await entry.async("nodebuffer");
    writeFileSync(out, buf);
    try {
      chmodSync(out, 0o755);
    } catch {
      /* Windows may ignore chmod */
    }
  }

  const foundBin = findFileByName(stagingDir, binaryName);
  if (!foundBin) {
    throw new Error(
      `llama-server binary not found after extract (searched for ${binaryName} under ${stagingDir})`,
    );
  }
  const stagedBin = join(stagingDir, binaryName);
  if (foundBin !== stagedBin) {
    // Promote the binary's parent directory contents into the staging
    // root so `llama-server` (and any sibling shared libs) sit at the
    // path the daemon lifecycle expects once swapped in, then remove
    // the now-orphaned wrapper dirs (e.g. `build/`, `release-root/`).
    moveContentsFlat(dirname(foundBin), stagingDir);
    const topWrapper = topLevelWrapper(stagingDir, foundBin);
    if (topWrapper !== null) {
      try {
        rmSync(topWrapper, { recursive: true, force: true });
      } catch {
        /* ignore — stray files, not fatal */
      }
    }
  }

  if (process.platform === "darwin") {
    try {
      execSync(`xattr -cr "${stagingDir}"`, { timeout: 10_000 });
    } catch {
      /* xattr may fail */
    }
  }

  rmSync(archivePath, { force: true });

  if (!existsSync(stagedBin)) {
    throw new Error(
      `llama-server binary not found after extract + flatten (expected ${binaryName} at ${stagedBin}; ` +
        `original location was ${relative(stagingDir, foundBin)})`,
    );
  }
  try {
    chmodSync(stagedBin, 0o755);
  } catch {
    /* Windows */
  }
  if (!stagedBinaryUsable(stagedBin)) {
    throw new Error(
      `staged llama-server at ${stagedBin} is not a usable executable — keeping the existing install`,
    );
  }
}

/**
 * Replace `backendDir` with `stagingDir`. Two renames, which is the
 * closest to atomic a directory swap gets on POSIX and Windows alike:
 * the live dir is moved aside first so the second rename lands on a
 * free name (`rename` onto a non-empty dir fails on both platforms).
 *
 * The window where neither dir is at the live path spans one rename of
 * an already-materialised sibling — microseconds, and no I/O that can
 * block on the network or the disk filling up. If the *second* rename
 * still fails, the old install is rolled back so the caller is left
 * with a working backend rather than none.
 */
export function swapInStagedBackend(
  backendDir: string,
  stagingDir: string,
  retiredDir: string,
): void {
  const hadLive = existsSync(backendDir);
  if (hadLive) renameSync(backendDir, retiredDir);
  try {
    renameSync(stagingDir, backendDir);
  } catch (err) {
    if (hadLive) {
      try {
        renameSync(retiredDir, backendDir);
      } catch {
        /* rollback failed too — surface the original error */
      }
    }
    throw err;
  }
  rmDirQuiet(retiredDir);
}

