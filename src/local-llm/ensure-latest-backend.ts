import {
  checkForBackendUpdate,
  downloadBackend,
  isBackendDownloaded,
} from "./backend-installer.js";
import type { DownloadProgressFn } from "./download-file.js";
import {
  readRunningPid,
  stopChatAndEmbeddingDaemons,
} from "./daemon-lifecycle.js";
import { hasOtherLiveSessions } from "./session-registry.js";

export type AutoUpdateBackendResult =
  | { action: "skipped" }
  | { action: "current"; tag: string | null }
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
  },
): Promise<AutoUpdateBackendResult> {
  if (!opts.enabled) return { action: "skipped" };

  let check: Awaited<ReturnType<typeof checkForBackendUpdate>>;
  try {
    check = await checkForBackendUpdate(dataDir);
  } catch (err) {
    return {
      action: "check_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!check.updateAvailable) {
    return { action: "current", tag: check.latestTag };
  }

  // Replacing the zip while llama-server still holds the old binary
  // fails on Windows (file lock) and leaves POSIX starts racing the
  // live pid. Stop both daemons first; the caller starts them after.
  // Skip the stop when another TUI/CLI session is live — killing their
  // model mid-chat is worse than sitting on an old tag until next solo start.
  try {
    if (readRunningPid(dataDir) !== null) {
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
