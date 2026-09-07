/**
 * Progress rendering shared by the foreground pull, the background
 * follower and the worker log. Kept apart from the handlers so the
 * two CLI modules can both use it without importing each other.
 */

export function formatGb(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * One line per retry so a flaky link reads as "retrying", not "hung".
 * Goes to stderr on its own row: the progress line is `\r`-rewritten
 * in place, and the note must survive the next rewrite.
 */
export function renderPullRetry(info: {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: Error;
}): string {
  return `download interrupted (${info.error.message}) — retry ${info.attempt}/${info.maxRetries} in ${Math.round(info.delayMs / 1000)}s, resuming from the partial file`;
}

export function renderPullProgress(
  label: string,
  percent: number,
  transferred: number,
  total: number,
): string {
  const barW = 20;
  const filled = Math.min(barW, Math.round((percent / 100) * barW));
  const bar = `${"=".repeat(filled)}${" ".repeat(barW - filled)}`;
  const tail =
    total > 0
      ? `${formatGb(transferred)} / ${formatGb(total)}`
      : `${formatGb(transferred)}`;
  return `[${bar}] ${percent}%  ${tail}  ${label}`;
}

