import type { LinkGeneratorOutcome } from "../links/link-generator-runner.js";
import type { ReflectionOutcome } from "../reflection/reflection-runner.js";
import type { RewriterOutcome } from "../retrieve/query-rewriter-runner.js";
import type { VoteRunnerOutcome } from "../voting/vote-runner.js";

import {
  formatSubcallHealthWarning,
  selectSubcallHealthSetting,
  summarizeFailureReason,
} from "./format-subcall-health-warning.js";

/** The memory sub-calls whose health is tracked. */
export type MemorySubcallKind =
  "reflection" | "link_generator" | "vote" | "rewriter";

/** Every outcome any of the tracked runners reports. */
export type MemorySubcallOutcome =
  | ReflectionOutcome
  | LinkGeneratorOutcome
  | VoteRunnerOutcome
  | RewriterOutcome;

export type UnhealthySubcallOutcome = "timeout" | "failed";

/**
 * Consecutive unhealthy outcomes before the operator is told. Low enough
 * that a session on a model that cannot run the sub-call hears about it
 * within a few turns, high enough that one slow reply is not news.
 */
export const MEMORY_SUBCALL_STREAK_THRESHOLD = 3;

export interface MemoryHealthWarning {
  kind: MemorySubcallKind;
  /** The outcome that completed the streak. */
  outcome: UnhealthySubcallOutcome;
  /** Length of the streak when the warning fired. */
  consecutive: number;
  /** The config key the message names. */
  setting: string;
  /** The last failure's reason, summarised. Absent for a timeout. */
  reason?: string;
  /** Operator-facing text (two lines). */
  message: string;
}

export interface SubcallHealthSample {
  sessionId: string;
  kind: MemorySubcallKind;
  outcome: MemorySubcallOutcome;
  reason?: string;
}

export interface SubcallHealthTracker {
  /**
   * Fold one outcome in. Returns a warning the first time a
   * (session, kind) streak reaches the threshold, and `null` on every
   * other call — including every call for that pair afterwards.
   */
  record(sample: SubcallHealthSample): MemoryHealthWarning | null;
}

/**
 * What one outcome does to a streak. `aborted` is neutral: a new turn
 * aborts the previous turn's still-running reflection by design, which
 * says nothing about whether the sub-call works. Every outcome that
 * reached the end without an error — a result, `none`, or a gate that
 * declined to call the model — proves the path is healthy.
 */
export function classifySubcallOutcome(
  outcome: MemorySubcallOutcome,
): "healthy" | "unhealthy" | "neutral" {
  switch (outcome) {
    case "timeout":
    case "failed":
      return "unhealthy";
    case "aborted":
      return "neutral";
    case "ok":
    case "none":
    case "skipped":
    case "skipped_no_history":
    case "skipped_not_referential":
      return "healthy";
  }
}

/**
 * Per-session, per-kind streak counter behind the "warn once" notice.
 * Pure: no clock, no I/O. A pair holds a streak entry only while it is
 * mid-streak, and a warned pair is remembered as one key for the
 * tracker's lifetime (the runtime's), which is what makes the warning
 * once-only.
 */
export function createSubcallHealthTracker(
  options: { threshold?: number } = {},
): SubcallHealthTracker {
  const threshold = Math.max(
    1,
    options.threshold ?? MEMORY_SUBCALL_STREAK_THRESHOLD,
  );
  const streaks = new Map<string, { count: number; reason?: string }>();
  const warned = new Set<string>();
  return {
    record(sample) {
      // Kind first: kinds are fixed tokens without a colon, so the key is
      // unambiguous whatever a session id contains.
      const key = `${sample.kind}:${sample.sessionId}`;
      if (warned.has(key)) return null;
      const verdict = classifySubcallOutcome(sample.outcome);
      if (verdict === "neutral") return null;
      if (verdict === "healthy") {
        streaks.delete(key);
        return null;
      }
      const previous = streaks.get(key);
      const count = (previous?.count ?? 0) + 1;
      const reason =
        sample.outcome === "failed" && sample.reason
          ? sample.reason
          : previous?.reason;
      if (count < threshold) {
        streaks.set(key, { count, ...(reason ? { reason } : {}) });
        return null;
      }
      streaks.delete(key);
      warned.add(key);
      const outcome: UnhealthySubcallOutcome =
        sample.outcome === "timeout" ? "timeout" : "failed";
      const quoted =
        outcome === "failed" && reason
          ? summarizeFailureReason(reason)
          : undefined;
      return {
        kind: sample.kind,
        outcome,
        consecutive: count,
        setting: selectSubcallHealthSetting(sample.kind, outcome),
        ...(quoted ? { reason: quoted } : {}),
        message: formatSubcallHealthWarning({
          kind: sample.kind,
          outcome,
          consecutive: count,
          ...(quoted ? { reason: quoted } : {}),
        }),
      };
    },
  };
}
