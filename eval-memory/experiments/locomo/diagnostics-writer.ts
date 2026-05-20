/**
 * Run-diagnostics writer for LoCoMo evaluations.
 *
 * The spec writes one `run-diagnostics.txt` per run under the report
 * directory. The file is human-readable plain text, one block per
 * `(profile, conversation)` scenario, separated by `---`. Diagnostic
 * blocks always include the scenario outcome (exit code, signal,
 * timed-out flag, wall clock), the kept-paths (when `keepStateDir`
 * was true), a turn-reason histogram, and the last ~4 KB of the
 * subprocess stderr.
 *
 * The motivation is the "empty replies tail" postmortem: the v1
 * harness emitted that information only as a Vitest WARNING which
 * died with the test process when the run was interrupted. The
 * diagnostics file is append-only, written incrementally inside the
 * `for (conv of dataset)` loop, so partial runs preserve postmortem
 * data even when the user kills the run mid-stream.
 *
 * `formatDiagnosticsEntry` is the only formatting surface; tests pin
 * the block shape so any future change (extra fields, reorderings)
 * fails loudly before reaching the file.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Per-scenario diagnostic record. Keys mirror the
 * `LocomoConversationResult` shape so the writer stays a pure data
 * adapter — no hidden field lookups from the runner's internals.
 */
export interface DiagnosticsEntry {
  profile: string;
  conversationId: string;
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  subprocessDurationMs: number;
  sessionId: string | null;
  /** Number of question rows produced (may be < `questionsAsked`). */
  questionsScored: number;
  /** Number of question rows with empty `assistantReply`. */
  emptyReplies: number;
  /**
   * Count of question rows grouped by `reason`. `null` reasons are
   * folded under the literal key `"<no-turn>"` to surface driver-side
   * disconnects distinctly from agent-side terminal verbs.
   */
  reasonHistogram: Readonly<Record<string, number>>;
  /**
   * Count of failed turns grouped by `failureCategory`. Empty when no
   * turn ended in `reason: "failed"`.
   */
  failureCategoryHistogram: Readonly<Record<string, number>>;
  /** When `keepStateDir: true`, the absolute path to the kept state dir. */
  keptStateDir: string | null;
  keptWorkingDir: string | null;
  keptTracePath: string | null;
  /** Last ~4 KB of subprocess stderr. */
  stderrTail: string;
}

/** Maximum stderr length included in the diagnostics block. */
export const STDERR_TAIL_MAX_LEN = 4096;

/**
 * Format a single diagnostics entry as a plain-text block. Pure: no
 * I/O, no `Date.now()`. The block always ends with a trailing `\n`
 * so `appendFileSync` writes safely.
 */
export function formatDiagnosticsEntry(entry: DiagnosticsEntry): string {
  const lines: string[] = [];
  const header = `## ${entry.profile} / ${entry.conversationId}`;
  lines.push(header);
  lines.push(`ok:          ${entry.ok}`);
  lines.push(`exitCode:    ${entry.exitCode}`);
  lines.push(`signal:      ${entry.signal ?? "-"}`);
  lines.push(`timedOut:    ${entry.timedOut}`);
  lines.push(`subprocessDurationMs: ${entry.subprocessDurationMs}`);
  lines.push(`sessionId:   ${entry.sessionId ?? "-"}`);
  lines.push(`questionsScored: ${entry.questionsScored}`);
  lines.push(`emptyReplies:    ${entry.emptyReplies}`);
  lines.push("reasonHistogram:");
  const reasonKeys = Object.keys(entry.reasonHistogram).sort();
  if (reasonKeys.length === 0) {
    lines.push("  (no turns recorded)");
  } else {
    for (const key of reasonKeys) {
      lines.push(`  ${key}: ${entry.reasonHistogram[key]}`);
    }
  }
  lines.push("failureCategoryHistogram:");
  const catKeys = Object.keys(entry.failureCategoryHistogram).sort();
  if (catKeys.length === 0) {
    lines.push("  (none)");
  } else {
    for (const key of catKeys) {
      lines.push(`  ${key}: ${entry.failureCategoryHistogram[key]}`);
    }
  }
  if (entry.keptStateDir) {
    lines.push(`keptStateDir:    ${entry.keptStateDir}`);
    lines.push(`keptWorkingDir:  ${entry.keptWorkingDir ?? "-"}`);
    lines.push(`keptTracePath:   ${entry.keptTracePath ?? "-"}`);
  }
  lines.push("stderrTail (last 4KB):");
  const tail = entry.stderrTail.slice(-STDERR_TAIL_MAX_LEN);
  lines.push(tail.length === 0 ? "  (empty)" : tail);
  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

/**
 * Build a `DiagnosticsEntry` from a question-level result array plus
 * the conversation outcome. The histograms are computed here so the
 * caller can hand off `LocomoConversationResult` shape verbatim.
 *
 * `questions` must be the per-question rows for this conversation
 * (one entry per question that the runner attempted to score); the
 * `reason` field on each is consumed verbatim — `null` is folded
 * into `<no-turn>` so we surface driver-side disconnects distinctly.
 */
export interface QuestionRow {
  assistantReply: string;
  reason: string | null;
  failureCategory: string | null;
}

export interface BuildDiagnosticsInput {
  profile: string;
  conversationId: string;
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  subprocessDurationMs: number;
  sessionId: string | null;
  questions: readonly QuestionRow[];
  keptStateDir: string | null;
  keptWorkingDir: string | null;
  keptTracePath: string | null;
  stderrTail: string;
}

/**
 * Compute reason / failure-category histograms from a per-question
 * row array. Pure; called by `buildDiagnosticsEntry`. Exposed for
 * tests that exercise the histogram independently.
 */
export function computeReasonHistogram(
  questions: readonly QuestionRow[],
): { reasonHistogram: Record<string, number>; failureCategoryHistogram: Record<string, number> } {
  const reasonHistogram: Record<string, number> = {};
  const failureCategoryHistogram: Record<string, number> = {};
  for (const q of questions) {
    const reasonKey = q.reason ?? "<no-turn>";
    reasonHistogram[reasonKey] = (reasonHistogram[reasonKey] ?? 0) + 1;
    if (q.reason === "failed" && q.failureCategory) {
      failureCategoryHistogram[q.failureCategory] =
        (failureCategoryHistogram[q.failureCategory] ?? 0) + 1;
    }
  }
  return { reasonHistogram, failureCategoryHistogram };
}

export function buildDiagnosticsEntry(input: BuildDiagnosticsInput): DiagnosticsEntry {
  const { reasonHistogram, failureCategoryHistogram } = computeReasonHistogram(input.questions);
  const emptyReplies = input.questions.reduce(
    (acc, q) => (q.assistantReply.trim().length === 0 ? acc + 1 : acc),
    0,
  );
  return {
    profile: input.profile,
    conversationId: input.conversationId,
    ok: input.ok,
    exitCode: input.exitCode,
    signal: input.signal,
    timedOut: input.timedOut,
    subprocessDurationMs: input.subprocessDurationMs,
    sessionId: input.sessionId,
    questionsScored: input.questions.length,
    emptyReplies,
    reasonHistogram,
    failureCategoryHistogram,
    keptStateDir: input.keptStateDir,
    keptWorkingDir: input.keptWorkingDir,
    keptTracePath: input.keptTracePath,
    stderrTail: input.stderrTail,
  };
}

/**
 * Append a diagnostics entry to the run's `run-diagnostics.txt`.
 * Creates parent directories on first call. Idempotent across calls
 * (always append-only). The file format is plain text; consumers
 * are expected to `cat` or `less` it during postmortem.
 */
export function appendRunDiagnostics(filePath: string, entry: DiagnosticsEntry): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, formatDiagnosticsEntry(entry), "utf8");
}

/**
 * Persist the full subprocess stderr to `<keptStateDir>/stderr.log`
 * when a state dir is kept on disk. No-op when `keptStateDir` is
 * null. Errors during the write are swallowed — diagnostics is a
 * best-effort sink and must never derail the run loop.
 */
export function dumpKeptStderr(
  keptStateDir: string | null,
  stderrAll: string,
): { written: boolean; path: string | null } {
  if (!keptStateDir) return { written: false, path: null };
  const path = `${keptStateDir}/stderr.log`;
  try {
    mkdirSync(keptStateDir, { recursive: true });
    appendFileSync(path, stderrAll, "utf8");
    return { written: true, path };
  } catch {
    return { written: false, path };
  }
}
