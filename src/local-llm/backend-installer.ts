import { execSync } from "node:child_process";
import {
  chmodSync,
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

import { resolveBackendDir, resolveServerBinPath } from "./backend-paths.js";
import { downloadFile } from "./download-file.js";
import { readBackendVersion, writeBackendVersion } from "./backend-version.js";
import { resolvePlatformAsset, UnsupportedPlatformError } from "./platform-assets.js";
import { resolveDownloadAsset } from "./windows-backend-variant.js";

const GITHUB_REPO = "AtomicBot-ai/atomic-llama-cpp-turboquant";

/**
 * Anonymous GitHub API allows ~60 req/h per IP. The Models tab polls
 * snapshots every 5s and each snapshot used to call `/releases/latest`,
 * so a few minutes of viewing was enough to get rate-limited (HTTP 403).
 * We cache the response process-wide for 10 minutes; an explicit
 * `models update` call still bypasses the cache via `force: true`.
 */
const RELEASE_CACHE_TTL_MS = 10 * 60_000;

/**
 * How many releases to scan when looking for the newest one that ships
 * our platform asset. The turboquant repo publishes a separate release
 * per platform, so `/releases/latest` (a single global "latest") is
 * unreliable — a Windows release can be newest while the Linux asset
 * lives an older release back. Scanning the list and matching on asset
 * name is robust to that.
 */
const RELEASES_PER_PAGE = 30;

export type ReleaseAsset = { name: string; browser_download_url: string };

export interface LatestReleaseInfo {
  tag: string;
  assets: ReleaseAsset[];
}

interface ReleaseCacheEntry {
  fetchedAt: number;
  release: LatestReleaseInfo;
}

/**
 * Cache keyed by platform asset name. Each platform resolves to a
 * different newest release, so a single global slot would thrash when
 * the Models tab and an install run from different platforms share a
 * process (and keeps the cache correct under test platform mocking).
 */
const releaseCache = new Map<string, ReleaseCacheEntry>();

/** Test/utility helper to clear the in-memory release cache. */
export function resetLatestReleaseCache(): void {
  releaseCache.clear();
}

export async function fetchLatestRelease(opts?: {
  force?: boolean;
}): Promise<LatestReleaseInfo> {
  const { assetName } = resolveDownloadAsset();
  const cached = releaseCache.get(assetName);
  if (
    !opts?.force &&
    cached &&
    Date.now() - cached.fetchedAt < RELEASE_CACHE_TTL_MS
  ) {
    return cached.release;
  }
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=${RELEASES_PER_PAGE}`;
  const headers: Record<string, string> = {
    "User-Agent": "atomic-agent/local-llm-backend",
    Accept: "application/vnd.github+json",
  };
  const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    if (res.status === 403 || res.status === 429) {
      throw new GithubRateLimitedError(res.status);
    }
    throw new Error(`Failed to fetch releases: HTTP ${res.status}`);
  }
  const data = (await res.json()) as Array<{
    tag_name: string;
    draft?: boolean;
    assets: Array<{ name: string; browser_download_url: string }>;
  }>;
  // GitHub lists releases newest-first; pick the first (non-draft) whose
  // assets include the asset for the current platform.
  const match = (Array.isArray(data) ? data : []).find(
    (r) => !r.draft && (r.assets ?? []).some((a) => a.name === assetName),
  );
  if (!match) {
    throw new Error(
      `No release found containing asset ${assetName} (scanned ${RELEASES_PER_PAGE} releases)`,
    );
  }
  const release: LatestReleaseInfo = {
    tag: match.tag_name,
    assets: match.assets ?? [],
  };
  releaseCache.set(assetName, { fetchedAt: Date.now(), release });
  return release;
}

export class GithubRateLimitedError extends Error {
  constructor(public readonly status: number) {
    super(
      `GitHub API rate-limited (HTTP ${status}). Set GITHUB_TOKEN to raise the cap to 5000/h.`,
    );
    this.name = "GithubRateLimitedError";
  }
}

export async function checkForBackendUpdate(
  dataDir: string,
): Promise<{ updateAvailable: boolean; latestTag: string; currentTag: string | null }> {
  const current = readBackendVersion(dataDir);
  const release = await fetchLatestRelease();
  return {
    updateAvailable: current?.tag !== release.tag,
    latestTag: release.tag,
    currentTag: current?.tag ?? null,
  };
}

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

export function isBackendDownloaded(dataDir: string): boolean {
  try {
    const { binaryName } = resolvePlatformAsset();
    return existsSync(resolveServerBinPath(dataDir, binaryName));
  } catch {
    return false;
  }
}

export async function downloadBackend(
  dataDir: string,
  opts?: {
    onProgress?: (percent: number, transferred: number, total: number) => void;
    signal?: AbortSignal;
  },
): Promise<{ ok: true; tag: string }> {
  const { assetName, binaryName } = resolveDownloadAsset();
  // Always hit GitHub for an actual install so we don't grab a stale
  // tag from the snapshot cache.
  const release = await fetchLatestRelease({ force: true });
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    const known = release.assets.map((a) => a.name).join(", ");
    throw new Error(
      `Backend asset not found: ${assetName}. Available: ${known || "<none>"}`,
    );
  }

  const backendDir = resolveBackendDir(dataDir);
  // Wipe any leftovers from a previous failed download so the flatten
  // step can't pick up stale `bin/` or `build/` wrappers. Done before
  // mkdir so a missing dir is fine.
  try {
    rmSync(backendDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  mkdirSync(backendDir, { recursive: true });
  const archivePath = join(backendDir, assetName);

  await downloadFile(asset.browser_download_url, archivePath, {
    onProgress: opts?.onProgress,
    userAgent: "atomic-agent/local-llm-backend-download",
    signal: opts?.signal,
  });

  const zip = await JSZip.loadAsync(readFileSync(archivePath));
  // Extract preserving the archive's internal layout. Flattening happens
  // in a second pass so we can support any of:
  //   * `llama-server` (flat)
  //   * `release-root/llama-server` (single top folder)
  //   * `build/bin/llama-server` (nested)
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const rel = normalizeZipPath(entry.name);
    if (!rel || rel.endsWith("/")) continue;
    const out = join(backendDir, rel);
    mkdirSync(dirname(out), { recursive: true });
    const buf = await entry.async("nodebuffer");
    writeFileSync(out, buf);
    try {
      chmodSync(out, 0o755);
    } catch {
      /* Windows may ignore chmod */
    }
  }

  const foundBin = findFileByName(backendDir, binaryName);
  if (!foundBin) {
    throw new Error(
      `llama-server binary not found after extract (searched for ${binaryName} under ${backendDir})`,
    );
  }
  const expectedBin = resolveServerBinPath(dataDir, binaryName);
  if (foundBin !== expectedBin) {
    // Promote the binary's parent directory contents into `backendDir`
    // so `llama-server` (and any sibling shared libs) sit at the path
    // the daemon lifecycle expects, then remove the now-orphaned
    // wrapper directories (e.g. `build/`, `release-root/`).
    moveContentsFlat(dirname(foundBin), backendDir);
    const topWrapper = topLevelWrapper(backendDir, foundBin);
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
      execSync(`xattr -cr "${backendDir}"`, { timeout: 10_000 });
    } catch {
      /* xattr may fail */
    }
  }

  rmSync(archivePath, { force: true });

  if (!existsSync(expectedBin)) {
    throw new Error(
      `llama-server binary not found after extract + flatten (expected ${binaryName} at ${expectedBin}; ` +
        `original location was ${relative(backendDir, foundBin)})`,
    );
  }
  try {
    chmodSync(expectedBin, 0o755);
  } catch {
    /* Windows */
  }

  writeBackendVersion(dataDir, {
    tag: release.tag,
    downloadedAt: new Date().toISOString(),
  });

  return { ok: true, tag: release.tag };
}

export { UnsupportedPlatformError };
