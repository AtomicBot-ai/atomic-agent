import type { WithImageCoreOptions } from "../../local-llm/core/core-image.js";

/** One progress line for a running media tool card (`tool_progress`). */
export interface MediaProgressUpdate { fraction: number; elapsedMs: number; label: string }

/** Download lines this often at most: each one is a feed line in the TUI. */
export const CORE_DOWNLOAD_PROGRESS_EVERY_MS = 5_000;

/**
 * The first picture or clip on a computer without Atomic Core downloads
 * the Core binary (about 65-117 MB) before anything else happens; without
 * a line the tool looks stuck (ATO-425). These hooks for `withImageCore`
 * say so once when it starts, then how far it got, throttled, and once
 * more when it is done.
 */
export function coreDownloadProgress(
  emit: ((update: MediaProgressUpdate) => void) | undefined,
  opts: { now?: () => number; everyMs?: number } = {},
): Pick<WithImageCoreOptions, "onCoreInstall" | "onCoreProgress"> {
  if (!emit) return {};
  const now = opts.now ?? Date.now;
  const every = opts.everyMs ?? CORE_DOWNLOAD_PROGRESS_EVERY_MS;
  const started = now();
  let last = -Infinity;
  let finished = false;
  const mb = (bytes: number) => Math.max(0, Math.round(bytes / 1_048_576));
  return {
    onCoreInstall: () => {
      last = now();
      emit({ fraction: 0, elapsedMs: 0, label: "downloading the Atomic Chat engine once (about 100 MB) before the first generation" });
    },
    onCoreProgress: (percent, transferred, total) => {
      if (finished) return;
      const at = now();
      const done = percent >= 100;
      if (!done && at - last < every) return;
      last = at;
      if (done) finished = true;
      const pct = Math.min(100, Math.max(0, Math.round(percent)));
      const size = total > 0 ? ` · ${mb(transferred)} of ${mb(total)} MB` : "";
      emit({
        fraction: pct / 100,
        elapsedMs: at - started,
        label: done ? "Atomic Chat engine downloaded, starting it" : `downloading the Atomic Chat engine · ${pct}%${size}`,
      });
    },
  };
}
