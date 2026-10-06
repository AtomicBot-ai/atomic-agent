import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

import {
  checkForBackendUpdate,
  downloadBackend,
  isBackendDownloaded,
  isInstalledVariantStale,
} from "./backend-installer.js";
import { resolveBackendCheckFilePath } from "../backend-paths.js";
import { readBackendVersion } from "./backend-version.js";
import type { DownloadProgressFn } from "../downloads/download-file.js";
import {
  readRunningPid,
  stopChatAndEmbeddingDaemons,
} from "../server/daemon-lifecycle.js";
import { hasOtherLiveSessions } from "../server/session-registry.js";
import { resolveDownloadAsset } from "./windows-backend-variant.js";

export type AutoUpdateBackendResult =
  | { action: "skipped" }
  | { action: "current"; tag: string | null }
  /**
   * A check recent enough (`recheckAfterMs`) already answered for the
   * build on disk, so nothing was asked. `tag` is the newest release it
   * found — `null` when that check failed or found none for this platform.
   */
  | { action: "recent"; tag: string | null; checkedAt: number }
  | { action: "updated"; from: string | null; to: string }
  | { action: "deferred"; reason: "other_session" | "daemon_live" }
  | { action: "check_failed"; error: string }
  /**
   * The version check said "update", but stopping the daemon or
   * downloading the replacement failed. `backendUsable` reports whether
   * a server binary is still on disk: the staged installer keeps the
   * previous install intact, so this is almost always true and the
   * caller should start it. False means there is genuinely nothing to
   * run and the caller must fail.
   */
  | { action: "update_failed"; error: string; backendUsable: boolean };

/**
 * How long a start trusts a release check that found nothing newer for
 * the build on disk (`recheckAfterMs`). The releases are nightly, and the
 * check is a GitHub round trip — up to its 5 s deadline — in front of the
 * model's start: the desktop starts the model through a fresh `models
 * start` process on every switch back to the local model, where the
 * process-wide release cache never survives, so every switch asked again.
 */
export const AUTO_UPDATE_RECHECK_MS = 6 * 60 * 60 * 1000;

/**
 * How long a check that failed (offline, rate-limited, a black-holed
 * connection that ran out the deadline) holds off the next one.
 */
export const AUTO_UPDATE_RETRY_MS = 15 * 60 * 1000;

/** The last check before a start, at `resolveBackendCheckFilePath`. */
interface BackendCheckRecord {
  /** Epoch ms of the check. */
  checkedAt: number;
  /** The build on disk it was made for (`backend-version.json`). */
  tag: string;
  asset: string | null;
  /** Whether GitHub answered. */
  ok: boolean;
  /** The newest release it found for this platform. */
  latestTag: string | null;
}

function readBackendCheck(dataDir: string): BackendCheckRecord | null {
  try {
    const parsed = JSON.parse(
      readFileSync(resolveBackendCheckFilePath(dataDir), "utf-8"),
    ) as Partial<BackendCheckRecord>;
    if (
      typeof parsed.checkedAt !== "number" ||
      !Number.isFinite(parsed.checkedAt) ||
      typeof parsed.tag !== "string" ||
      typeof parsed.ok !== "boolean"
    ) {
      return null;
    }
    return {
      checkedAt: parsed.checkedAt,
      tag: parsed.tag,
      asset: typeof parsed.asset === "string" ? parsed.asset : null,
      ok: parsed.ok,
      latestTag: typeof parsed.latestTag === "string" ? parsed.latestTag : null,
    };
  } catch {
    return null;
  }
}

/** Best-effort: a record that cannot be written only means the next start asks again. */
function noteBackendCheck(
  dataDir: string,
  checkedAt: number,
  outcome: { ok: boolean; latestTag: string | null },
): void {
  const installed = readBackendVersion(dataDir);
  if (!installed) return;
  const record: BackendCheckRecord = {
    checkedAt,
    tag: installed.tag,
    asset: installed.asset ?? null,
    ...outcome,
  };
  try {
    writeFileSync(resolveBackendCheckFilePath(dataDir), JSON.stringify(record), "utf-8");
  } catch {
    /* asked again next time */
  }
}

/**
 * Drop the last check's record, so the next start asks GitHub again. For
 * a check made elsewhere that found an update: a view offering an update
 * while a start trusted an older "nothing newer" would have the two
 * disagree for up to `AUTO_UPDATE_RECHECK_MS`.
 */
export function forgetBackendCheck(dataDir: string): void {
  try {
    unlinkSync(resolveBackendCheckFilePath(dataDir));
  } catch {
    /* none recorded */
  }
}

/**
 * `checkForBackendUpdate` for a view that shows whether an update is
 * available — the TUI's Models panel, which asks on every refresh. When it
 * finds one, the record a start trusts is dropped (`forgetBackendCheck`),
 * so the next start asks too and installs it.
 */
export async function checkForBackendUpdateForPanel(
  dataDir: string,
): Promise<Awaited<ReturnType<typeof checkForBackendUpdate>>> {
  const result = await checkForBackendUpdate(dataDir);
  if (result.updateAvailable) forgetBackendCheck(dataDir);
  return result;
}

/**
 * The last check, when it still stands for the build on disk: made for
 * this tag and asset, younger than its window (`AUTO_UPDATE_RETRY_MS` at
 * most when it failed), and the machine still wants the asset that is
 * installed — a variant change (an NVIDIA driver installed since) is an
 * update in itself, so that always asks, and so does a Windows CUDA
 * build that lost or never had its CUDA runtime (ATO-244).
 */
function standingCheck(
  dataDir: string,
  now: number,
  recheckAfterMs: number,
): BackendCheckRecord | null {
  const last = readBackendCheck(dataDir);
  const installed = readBackendVersion(dataDir);
  if (
    !last ||
    !installed ||
    last.tag !== installed.tag ||
    last.asset !== (installed.asset ?? null)
  ) {
    return null;
  }
  if (installed.asset !== undefined) {
    let wanted: string;
    try {
      wanted = resolveDownloadAsset().assetName;
    } catch {
      return null;
    }
    // Same verdict as `checkForBackendUpdate`: a Vulkan install standing
    // in for a refused CUDA zip of the release last seen still stands,
    // and a CUDA build missing its runtime (ATO-244) never does.
    if (isInstalledVariantStale(dataDir, installed, wanted, last.latestTag)) {
      return null;
    }
  }
  const window = last.ok
    ? recheckAfterMs
    : Math.min(recheckAfterMs, AUTO_UPDATE_RETRY_MS);
  const age = now - last.checkedAt;
  return age >= 0 && age < window ? last : null;
}

/**
 * When `enabled`, pull a newer llama.cpp backend from GitHub Releases
 * before the managed daemon starts. Missing-backend first install is
 * still owned by the TUI/CLI start paths; this only upgrades an already
 * installed zip. Failures anywhere in the update are fire-safe: this
 * never throws, and every non-fatal outcome leaves the caller free to
 * start the binary already on disk instead of aborting the turn. That
 * matters most *after* the daemon was stopped for the update — an
 * exception there used to leave the user with nothing running, which is
 * strictly worse than never having attempted the update.
 */
export async function maybeAutoUpdateBackend(
  dataDir: string,
  opts: {
    enabled: boolean;
    onProgress?: DownloadProgressFn;
    onWillDownload?: () => void;
    /**
     * Abort the (27-39 MB) asset download. Without one a stalled but
     * open connection never resolves and the update hangs for the
     * lifetime of the process.
     */
    signal?: AbortSignal;
    /**
     * Never stop a running daemon to install the update. Set by the
     * deferred pass that runs *after* start: there the live daemon is
     * the one serving the user, and `hasOtherLiveSessions` cannot see
     * it — it skips our own pid by design — so without this the
     * background update would kill the model mid-turn.
     */
    keepDaemonRunning?: boolean;
    /**
     * Trust a check this recent for the build on disk, from any process
     * (`AUTO_UPDATE_RECHECK_MS` for the start paths): answer `recent`
     * without asking GitHub, and remember what this check found. Absent
     * or `0`: always ask, remember nothing — `models update` and anything
     * else that means "check now".
     */
    recheckAfterMs?: number;
    /** Clock for the check record; tests pass one. */
    now?: () => number;
  },
): Promise<AutoUpdateBackendResult> {
  if (!opts.enabled) return { action: "skipped" };
  const now = opts.now ?? Date.now;
  const remember = (opts.recheckAfterMs ?? 0) > 0;
  if (remember) {
    const standing = standingCheck(dataDir, now(), opts.recheckAfterMs ?? 0);
    if (standing) {
      return {
        action: "recent",
        tag: standing.latestTag,
        checkedAt: standing.checkedAt,
      };
    }
  }

  let check: Awaited<ReturnType<typeof checkForBackendUpdate>>;
  try {
    check = await checkForBackendUpdate(dataDir);
  } catch (err) {
    if (remember) noteBackendCheck(dataDir, now(), { ok: false, latestTag: null });
    return {
      action: "check_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!check.updateAvailable) {
    if (remember) {
      noteBackendCheck(dataDir, now(), { ok: true, latestTag: check.latestTag });
    }
    return { action: "current", tag: check.latestTag };
  }

  // Replacing the zip while llama-server still holds the old binary
  // fails on Windows (file lock) and leaves POSIX starts racing the
  // live pid. Stop both daemons first; the caller starts them after.
  // Skip the stop when another TUI/CLI session is live — killing their
  // model mid-chat is worse than sitting on an old tag until next solo start.
  // The embedding daemon counts on its own: a host can run it alone (`models
  // start-embedding`, which the desktop runs before the chat model starts),
  // and its binary is the same one being replaced.
  try {
    if (readRunningPid(dataDir) !== null || readRunningPid(dataDir, "embedding") !== null) {
      if (opts.keepDaemonRunning) {
        return { action: "deferred", reason: "daemon_live" };
      }
      if (hasOtherLiveSessions(dataDir)) {
        return { action: "deferred", reason: "other_session" };
      }
      await stopChatAndEmbeddingDaemons(dataDir);
    }

    opts.onWillDownload?.();
    const downloaded = await downloadBackend(dataDir, {
      onProgress: opts.onProgress,
      signal: opts.signal,
    });
    if (remember) {
      noteBackendCheck(dataDir, now(), { ok: true, latestTag: downloaded.tag });
    }
    return {
      action: "updated",
      from: check.currentTag,
      to: downloaded.tag,
    };
  } catch (err) {
    return {
      action: "update_failed",
      error: err instanceof Error ? err.message : String(err),
      backendUsable: isBackendDownloaded(dataDir),
    };
  }
}
