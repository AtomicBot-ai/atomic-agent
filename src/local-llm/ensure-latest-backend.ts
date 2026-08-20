import {
  checkForBackendUpdate,
  downloadBackend,
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
  | { action: "deferred"; reason: "other_session" }
  | { action: "check_failed"; error: string };

/**
 * When `enabled`, pull a newer llama.cpp backend from GitHub Releases
 * before the managed daemon starts. Missing-backend first install is
 * still owned by the TUI/CLI start paths; this only upgrades an already
 * installed zip. Check failures are fire-safe — the caller starts the
 * current binary instead of aborting the turn.
 */
export async function maybeAutoUpdateBackend(
  dataDir: string,
  opts: {
    enabled: boolean;
    onProgress?: DownloadProgressFn;
    onWillDownload?: () => void;
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
  if (readRunningPid(dataDir) !== null) {
    if (hasOtherLiveSessions(dataDir)) {
      return { action: "deferred", reason: "other_session" };
    }
    await stopChatAndEmbeddingDaemons(dataDir);
  }

  opts.onWillDownload?.();
  const downloaded = await downloadBackend(dataDir, {
    onProgress: opts.onProgress,
  });
  return {
    action: "updated",
    from: check.currentTag,
    to: downloaded.tag,
  };
}
