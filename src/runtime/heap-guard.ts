import v8 from "node:v8";

/**
 * Heap headroom watchdog.
 *
 * Issue #121: a long session died with `FATAL ERROR: Ineffective
 * mark-compacts near heap limit` at 4083 MB — Node's *default* ceiling
 * (~4288 MB), because the SEA build sets no `--max-old-space-size`. The
 * process vanished with no warning and took ~40 minutes of work with it.
 *
 * V8 cannot raise its own ceiling after startup (`setFlagsFromString`
 * is a no-op for `--max-old-space-size` once the heap exists), so this
 * cannot prevent the crash. What it can do is make the crash *legible*:
 * warn while there is still headroom to save work and restart with a
 * bigger ceiling.
 *
 * Pure except for the injected `readHeap`, so the thresholds are unit
 * testable without allocating gigabytes.
 */

export interface HeapReading {
  usedBytes: number;
  limitBytes: number;
}

export type HeapSeverity = "ok" | "warn" | "critical";

export interface HeapStatus {
  severity: HeapSeverity;
  usedBytes: number;
  limitBytes: number;
  /** Fraction of the ceiling in use, 0..1. */
  ratio: number;
  /** Operator-facing line; `null` while `ok`. */
  message: string | null;
}

/** Fraction of the heap ceiling at which we start warning. */
export const HEAP_WARN_RATIO = 0.75;
/** Fraction at which a crash is imminent and the wording escalates. */
export const HEAP_CRITICAL_RATIO = 0.9;

export function readProcessHeap(): HeapReading {
  const s = v8.getHeapStatistics();
  return { usedBytes: s.used_heap_size, limitBytes: s.heap_size_limit };
}

function mb(bytes: number): string {
  return `${Math.round(bytes / 1_048_576)} MB`;
}

/**
 * Classify one heap reading. `limitBytes <= 0` (a runtime that does not
 * report a ceiling) is treated as "ok" rather than dividing by zero.
 */
export function classifyHeap(reading: HeapReading): HeapStatus {
  const { usedBytes, limitBytes } = reading;
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
    return { severity: "ok", usedBytes, limitBytes, ratio: 0, message: null };
  }
  const ratio = usedBytes / limitBytes;
  if (ratio >= HEAP_CRITICAL_RATIO) {
    return {
      severity: "critical",
      usedBytes,
      limitBytes,
      ratio,
      message:
        `memory critical: ${mb(usedBytes)} of ${mb(limitBytes)} used. ` +
        `The agent may be killed by the runtime without warning — finish or ` +
        `save this turn, then restart with a bigger heap: ` +
        `NODE_OPTIONS=--max-old-space-size=8192`,
    };
  }
  if (ratio >= HEAP_WARN_RATIO) {
    return {
      severity: "warn",
      usedBytes,
      limitBytes,
      ratio,
      message:
        `memory high: ${mb(usedBytes)} of ${mb(limitBytes)} used. ` +
        `Long sessions with large file reads can exhaust the default heap; ` +
        `restarting with NODE_OPTIONS=--max-old-space-size=8192 raises it.`,
    };
  }
  return { severity: "ok", usedBytes, limitBytes, ratio, message: null };
}

/**
 * Stateful wrapper that reports only when severity *rises*, so a session
 * sitting at 76% does not repeat the same line on every poll. Dropping
 * back below a threshold re-arms it.
 */
export function createHeapGuard(
  readHeap: () => HeapReading = readProcessHeap,
): { check: () => HeapStatus | null } {
  const rank: Record<HeapSeverity, number> = { ok: 0, warn: 1, critical: 2 };
  let reported: HeapSeverity = "ok";
  return {
    check(): HeapStatus | null {
      const status = classifyHeap(readHeap());
      if (rank[status.severity] > rank[reported]) {
        reported = status.severity;
        return status;
      }
      if (rank[status.severity] < rank[reported]) reported = status.severity;
      return null;
    },
  };
}
