import { getAppVersion } from "../version.js";
import { isNewerVersion } from "./compare-semver.js";
import {
  parseUpdatePolicy,
  requiredUpdateReason,
  type RequiredUpdateReason,
  type UpdatePolicy,
} from "./update-policy.js";

export interface AppUpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestTag: string;
  /** `latestTag` with a leading `v` stripped, for display. */
  latestVersion: string;
  /**
   * ATO-1125: the latest release's policy lists the running version as
   * broken or below its minimum (update-policy.ts). Always false when
   * `updateAvailable` is. How hard to insist is up to the caller.
   */
  updateRequired: boolean;
  requiredReason: RequiredUpdateReason | null;
}

export class AppUpdateCheckError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = "AppUpdateCheckError";
  }
}

/**
 * Anonymous GitHub API allows ~60 req/h per IP. The startup check fires
 * once per TUI launch, so a short process-wide cache mainly guards
 * against rapid relaunches during development.
 */
const RELEASE_CACHE_TTL_MS = 10 * 60_000;
/** A release lookup runs on the start path and must never hold it. */
const UPDATE_CHECK_TIMEOUT_MS = 15_000;

interface CacheEntry {
  repo: string;
  fetchedAt: number;
  tag: string;
  policy: UpdatePolicy;
}

let cache: CacheEntry | null = null;

/** Test helper: clear the in-memory latest-release cache. */
export function resetAppReleaseCache(): void {
  cache = null;
}

async function fetchLatestRelease(
  repo: string,
  fetchImpl: typeof fetch,
): Promise<{ tag: string; policy: UpdatePolicy }> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const headers: Record<string, string> = {
    "User-Agent": "atomic-agent/self-update",
    Accept: "application/vnd.github+json",
  };
  const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetchImpl(url, {
    headers,
    // A release lookup runs on the start path; it had no clock of its
    // own and inherited the transport's, which is no longer five
    // minutes — see `installTransportDeadlines`.
    signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new AppUpdateCheckError(
      `Failed to fetch latest release: HTTP ${res.status}`,
      res.status,
    );
  }
  const data = (await res.json()) as { tag_name?: unknown; body?: unknown };
  if (typeof data.tag_name !== "string" || data.tag_name.length === 0) {
    throw new AppUpdateCheckError("Latest release has no tag_name", null);
  }
  return {
    tag: data.tag_name,
    policy: parseUpdatePolicy(typeof data.body === "string" ? data.body : null),
  };
}

/**
 * Query the GitHub Releases API for `repo` and compare the latest tag
 * with the running version. Throws {@link AppUpdateCheckError} on
 * transport / API failures so callers can decide whether to surface or
 * swallow the error (startup checks swallow it).
 */
export async function checkForAppUpdate(opts?: {
  repo?: string;
  currentVersion?: string;
  fetchImpl?: typeof fetch;
  force?: boolean;
}): Promise<AppUpdateCheckResult> {
  const repo = opts?.repo ?? "AtomicBot-ai/atomic-agent";
  const currentVersion = opts?.currentVersion ?? getAppVersion();
  const fetchImpl = opts?.fetchImpl ?? fetch;

  let tag: string;
  let policy: UpdatePolicy;
  if (
    !opts?.force &&
    cache &&
    cache.repo === repo &&
    Date.now() - cache.fetchedAt < RELEASE_CACHE_TTL_MS
  ) {
    tag = cache.tag;
    policy = cache.policy;
  } else {
    ({ tag, policy } = await fetchLatestRelease(repo, fetchImpl));
    cache = { repo, fetchedAt: Date.now(), tag, policy };
  }

  const latestVersion = tag.replace(/^v/i, "");
  const requiredReason = requiredUpdateReason(currentVersion, latestVersion, policy);
  return {
    updateAvailable: isNewerVersion(latestVersion, currentVersion),
    currentVersion,
    latestTag: tag,
    latestVersion,
    updateRequired: requiredReason !== null,
    requiredReason,
  };
}
