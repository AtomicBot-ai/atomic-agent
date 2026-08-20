import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { resolveBackendDir, resolveServerBinPath } from "./backend-paths.js";
import {
  extractBackendArchive,
  rmDirQuiet,
  swapInStagedBackend,
} from "./backend-staging.js";
import { downloadFile } from "./download-file.js";
import { readBackendVersion, writeBackendVersionAt } from "./backend-version.js";
import { resolvePlatformAsset, UnsupportedPlatformError } from "./platform-assets.js";
import { resolveDownloadAsset } from "./windows-backend-variant.js";

const GITHUB_REPO = "AtomicBot-ai/atomic-llama-cpp-turboquant-nightly";

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

/**
 * Timeout for the small releases-list JSON request. With auto-update on
 * this call sits on the critical path of every managed start, and a
 * black-holed connection (captive portal, DNS sinkhole) would otherwise
 * hang until the OS TCP timeout — ~130s on Linux — before the daemon
 * even begins to boot. Aborting at 5s turns that into a normal check
 * failure and the caller starts the binary already on disk. Only the
 * JSON request is bounded; the multi-hundred-MB asset download keeps
 * the caller's own `opts.signal`.
 */
const RELEASES_FETCH_TIMEOUT_MS = 5_000;

export type ReleaseAsset = { name: string; browser_download_url: string };

export interface LatestReleaseInfo {
  tag: string;
  assets: ReleaseAsset[];
  /**
   * `published_at` (or `created_at` when a release was never published)
   * as ISO-8601, or null when GitHub omitted both. Used to order this
   * release against the installed one — the repo is a nightly, and its
   * tags are not semver-sortable.
   */
  releasedAt: string | null;
}

interface ReleaseCacheEntry {
  fetchedAt: number;
  /** `null` = scanned successfully, no release carries our asset. */
  release: LatestReleaseInfo | null;
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

/**
 * Resolve the newest release that ships this platform's asset, or
 * `null` when none of the scanned releases carries it.
 */
export async function fetchLatestRelease(opts?: {
  force?: boolean;
}): Promise<LatestReleaseInfo | null> {
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

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(RELEASES_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    if (res.status === 403 || res.status === 429) {
      throw new GithubRateLimitedError(res.status);
    }
    throw new Error(`Failed to fetch releases: HTTP ${res.status}`);
  }
  const data = (await res.json()) as Array<{
    tag_name: string;
    draft?: boolean;
    published_at?: string | null;
    created_at?: string | null;
    assets: Array<{ name: string; browser_download_url: string }>;
  }>;
  // GitHub lists releases newest-first *by creation*, which is not the
  // same as newest-published: re-publishing or backfilling an old tag
  // moves it. Collect every non-draft release carrying our platform
  // asset and pick the one with the newest release timestamp, falling
  // back to GitHub's own order when timestamps are missing.
  const candidates = (Array.isArray(data) ? data : []).filter(
    (r) => !r.draft && (r.assets ?? []).some((a) => a.name === assetName),
  );
  if (candidates.length === 0) {
    // A rarely-built platform's newest asset can fall off page 1 of the
    // list. That is "nothing to update to", not a hard error: throwing
    // here would fail the check on every single start and, with the
    // pre-staging installer, was the only thing standing between the
    // user and a working binary already on disk.
    releaseCache.set(assetName, { fetchedAt: Date.now(), release: null });
    return null;
  }
  const match = candidates.reduce((best, cur) =>
    releaseTime(cur) > releaseTime(best) ? cur : best,
  );
  const release: LatestReleaseInfo = {
    tag: match.tag_name,
    assets: match.assets ?? [],
    releasedAt: match.published_at ?? match.created_at ?? null,
  };
  releaseCache.set(assetName, { fetchedAt: Date.now(), release });
  return release;
}

/**
 * Sort key for release recency. `-Infinity` for a release with no
 * usable timestamp so it never displaces a dated one; ties keep the
 * earlier (GitHub-ordered) candidate because `reduce` only swaps on a
 * strict improvement.
 */
function releaseTime(r: { published_at?: string | null; created_at?: string | null }): number {
  const raw = r.published_at ?? r.created_at;
  if (!raw) return -Infinity;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? -Infinity : t;
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
): Promise<{
  updateAvailable: boolean;
  latestTag: string | null;
  currentTag: string | null;
}> {
  const current = readBackendVersion(dataDir);
  const release = await fetchLatestRelease();
  // A variant mismatch counts as an update even at the same tag: a
  // Windows box that installed the Vulkan build before its NVIDIA driver
  // was present would otherwise keep running Vulkan (and offloading to
  // whatever device Vulkan enumerates) forever. This is a property of
  // the local machine, not of release ordering, so it is checked before
  // (and independently of) the recency comparison.
  const variantStale =
    current?.asset !== undefined && current.asset !== resolveDownloadAsset().assetName;
  if (release === null) {
    // Nothing resolvable to update *to* — keep whatever is installed.
    return {
      updateAvailable: false,
      latestTag: null,
      currentTag: current?.tag ?? null,
    };
  }
  return {
    updateAvailable: variantStale || isNewerRelease(current, release),
    latestTag: release.tag,
    currentTag: current?.tag ?? null,
  };
}

/**
 * Is `release` genuinely newer than what is installed?
 *
 * A bare `current.tag !== release.tag` also fires when the resolved
 * release is *older* — which happens for real on a nightly repo whose
 * tags are not semver-sortable: re-publishing or backfilling a tag
 * moves it, and every client would silently downgrade on next start.
 * Two contending releases would additionally re-download hundreds of MB
 * and bounce the daemon on *every* start.
 *
 * Release timestamps are the only defensible ordering available here,
 * so when both sides carry one we require a strict increase. When
 * either is missing — no install yet, or a version file written before
 * `releasedAt` existed — we fall back to tag inequality so those users
 * still converge onto the current build once.
 */
function isNewerRelease(
  current: { tag: string; releasedAt?: string } | null,
  release: LatestReleaseInfo,
): boolean {
  if (current === null) return true;
  if (current.tag === release.tag) return false;
  const currentAt = current.releasedAt ? Date.parse(current.releasedAt) : NaN;
  const releaseAt = release.releasedAt ? Date.parse(release.releasedAt) : NaN;
  if (Number.isNaN(currentAt) || Number.isNaN(releaseAt)) return true;
  return releaseAt > currentAt;
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
  if (release === null) {
    throw new Error(
      `No release found containing asset ${assetName} (scanned ${RELEASES_PER_PAGE} releases)`,
    );
  }
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    const known = release.assets.map((a) => a.name).join(", ");
    throw new Error(
      `Backend asset not found: ${assetName}. Available: ${known || "<none>"}`,
    );
  }

  const backendDir = resolveBackendDir(dataDir);
  // Download and extract into a sibling staging dir, never into the
  // live one. The old code wiped `backend/` first and only then pulled
  // several hundred MB, so a network drop, a Ctrl-C, a corrupt zip or a
  // full disk left the user with no backend at all — and with
  // auto-update this path now runs on every managed start, not just an
  // explicit `models update`. Siblings (not tmpdir) so the final swap
  // stays on one filesystem and can be a rename.
  const stagingDir = `${backendDir}.next`;
  const retiredDir = `${backendDir}.old`;
  // A previous crash can leave either behind; both are scratch, and a
  // stale `.next` would otherwise poison the flatten step with foreign
  // `bin/` or `build/` wrappers.
  rmDirQuiet(stagingDir);
  rmDirQuiet(retiredDir);
  mkdirSync(stagingDir, { recursive: true });

  try {
    const archivePath = join(stagingDir, assetName);
    await downloadFile(asset.browser_download_url, archivePath, {
      onProgress: opts?.onProgress,
      userAgent: "atomic-agent/local-llm-backend-download",
      signal: opts?.signal,
    });

    await extractBackendArchive(archivePath, stagingDir, binaryName);

    // The version record lives inside `backend/`, so it is staged with
    // the rest of the tree and rides in on the swap. It therefore never
    // describes anything other than what is actually live, and a
    // failure before this point leaves the old record untouched.
    writeBackendVersionAt(stagingDir, {
      tag: release.tag,
      downloadedAt: new Date().toISOString(),
      asset: assetName,
      ...(release.releasedAt ? { releasedAt: release.releasedAt } : {}),
    });

    swapInStagedBackend(backendDir, stagingDir, retiredDir);
  } catch (err) {
    // Leave the existing install exactly as it was.
    rmDirQuiet(stagingDir);
    throw err;
  }

  return { ok: true, tag: release.tag };
}

export { UnsupportedPlatformError };
