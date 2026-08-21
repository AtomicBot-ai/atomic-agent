import { useEffect, useRef, useState } from "react";

export interface TransferRate {
  /** Bytes per second, smoothed. `null` until two samples exist. */
  bytesPerSecond: number | null;
  /** Seconds remaining at the current rate, or `null` when unknowable. */
  etaSeconds: number | null;
}

/** Weight of each new sample. Low enough that a stalled chunk does not
 * make the estimate lurch, high enough to follow a real slowdown. */
const SMOOTHING = 0.3;

/**
 * Turn a growing byte count into a rate and an ETA.
 *
 * The progress events carry totals, not speed — a percentage alone
 * cannot answer "do I have time to make coffee", which is the only
 * question a multi-gigabyte download raises. Smoothed with an EMA
 * because raw deltas between two HTTP chunks swing wildly.
 */
export function useTransferRate(
  transferredBytes: number,
  totalBytes: number,
): TransferRate {
  const [rate, setRate] = useState<number | null>(null);
  const last = useRef<{ bytes: number; at: number } | null>(null);

  useEffect(() => {
    const now = Date.now();
    const previous = last.current;
    last.current = { bytes: transferredBytes, at: now };
    if (!previous) return;
    const elapsedSeconds = (now - previous.at) / 1000;
    const delta = transferredBytes - previous.bytes;
    // A restart (a new download reusing the slot) resets the estimate
    // rather than reporting a negative rate.
    if (delta < 0) {
      setRate(null);
      return;
    }
    if (elapsedSeconds <= 0) return;
    const sample = delta / elapsedSeconds;
    setRate((prev) => (prev === null ? sample : prev + SMOOTHING * (sample - prev)));
  }, [transferredBytes]);

  const remaining = Math.max(0, totalBytes - transferredBytes);
  const etaSeconds = rate && rate > 0 ? Math.round(remaining / rate) : null;
  return { bytesPerSecond: rate, etaSeconds };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} kB`;
  return `${bytes} B`;
}

export function formatEta(seconds: number | null): string {
  if (seconds === null) return "estimating…";
  if (seconds < 60) return "less than a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"} left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours}h ${rest}m left`;
}
