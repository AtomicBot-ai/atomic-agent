import { useEffect, useState } from "react";

/**
 * React hook: returns the elapsed time (ms) since `startedAt`, updating
 * every `tickMs`. When `startedAt` is `null` the hook returns `null` and
 * stops its interval — mimicking openclaw's `statusTimer` lifecycle.
 */
export function useElapsed(
  startedAt: number | null,
  tickMs = 1000,
): number | null {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const handle = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(handle);
  }, [startedAt, tickMs]);
  if (startedAt === null) return null;
  return Math.max(0, now - startedAt);
}

/** Render an elapsed duration in `12s` or `1m 07s` form. */
export function formatElapsed(elapsedMs: number | null): string {
  if (elapsedMs === null) return "0s";
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
