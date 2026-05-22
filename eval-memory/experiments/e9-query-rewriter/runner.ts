/**
 * E9 — query-rewriter runner.
 *
 * Drives each case through `runIsolatedRewriter`:
 *   - "live"     — adapt the harness HTTP client into a
 *                  `RewriterLlmComplete`.
 *   - "timeout"  — same live LLM but with a 1ms `timeoutMs`.
 *   - "stub"     — synthetic completion (used for parser failure
 *                  modes the live model rarely reproduces).
 *
 * The runner classifies each case as `pass`/`fail` against the
 * declared `expectedOutcome` + optional `expectedSubstring`. The
 * spec asserts aggregate pass rate so the suite stays useful when
 * a few cases are flaky on a small model.
 */

import {
  adaptHarnessLlmToRewriterComplete,
  makeStubRewriterComplete,
  runIsolatedRewriter,
  type IsolatedRewriterResult,
} from "../../harness/rewriter-isolated.js";
import type {
  LlmCompleteParams,
  LlmCompleteResult,
} from "../../harness/llm-client.js";

import { REWRITER_CASES, type RewriterCase } from "./dataset.js";

export interface E9CaseResult {
  caseId: string;
  label: string;
  mode: RewriterCase["mode"];
  expectedOutcome: RewriterCase["expectedOutcome"];
  observedOutcome: IsolatedRewriterResult["outcome"];
  rewritten: string;
  rawMessage: string;
  pass: boolean;
  failReasons: readonly string[];
  durationMs: number;
  slotIdSeen: number;
}

export interface E9Aggregate {
  cases: number;
  passes: number;
  failures: number;
  /** Share of cases that observed `outcome === expectedOutcome`. */
  outcomeMatchRate: number;
  /** Share of cases where ALL declared assertions held. */
  passRate: number;
  /** Cases where the runner produced an answer on the wrong slot. */
  slotInvariantViolations: number;
}

export interface E9Report {
  cases: readonly E9CaseResult[];
  aggregate: E9Aggregate;
}

export interface E9RunnerDeps {
  llmComplete: (params: LlmCompleteParams) => Promise<LlmCompleteResult>;
}

export interface E9RunnerOptions {
  /** Default `timeoutMs` for live cases (overridable per-case). */
  defaultTimeoutMs?: number;
  caseIds?: readonly string[];
}

export async function runE9(
  deps: E9RunnerDeps,
  opts: E9RunnerOptions = {},
): Promise<E9Report> {
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
  const adapter = adaptHarnessLlmToRewriterComplete(deps.llmComplete);

  const filtered = opts.caseIds
    ? REWRITER_CASES.filter((c) => opts.caseIds!.includes(c.id))
    : REWRITER_CASES;

  const results: E9CaseResult[] = [];
  for (const c of filtered) {
    results.push(await runCase(c, adapter, deps.llmComplete, defaultTimeoutMs));
  }
  return { cases: results, aggregate: aggregate(results) };
}

async function runCase(
  c: RewriterCase,
  liveAdapter: ReturnType<typeof adaptHarnessLlmToRewriterComplete>,
  rawLlm: E9RunnerDeps["llmComplete"],
  defaultTimeoutMs: number,
): Promise<E9CaseResult> {
  let timeoutMs = c.timeoutMs ?? defaultTimeoutMs;
  let llm = liveAdapter;
  if (c.mode === "stub") {
    if (typeof c.stubCompletion !== "string") {
      throw new Error(
        `case ${c.id}: stub mode requires stubCompletion body`,
      );
    }
    llm = makeStubRewriterComplete(c.stubCompletion);
  } else if (c.mode === "timeout") {
    timeoutMs = c.timeoutMs ?? 1;
  }

  const sessionId = `e9-${c.id}`;
  let observed: IsolatedRewriterResult;
  try {
    observed = await runIsolatedRewriter(
      {
        sessionId,
        userMessage: c.userMessage,
        history: c.history,
      },
      { llmComplete: llm, timeoutMs },
    );
  } catch (err) {
    void rawLlm; // unused in catch — present in deps signature for clarity
    return {
      caseId: c.id,
      label: c.label,
      mode: c.mode,
      expectedOutcome: c.expectedOutcome,
      observedOutcome: "failed",
      rewritten: c.userMessage,
      rawMessage: c.userMessage,
      pass: false,
      failReasons: [
        `runtime error: ${err instanceof Error ? err.message : String(err)}`,
      ],
      durationMs: 0,
      slotIdSeen: -1,
    };
  }

  const failReasons: string[] = [];
  if (observed.outcome !== c.expectedOutcome) {
    failReasons.push(
      `outcome mismatch: expected ${c.expectedOutcome}, observed ${observed.outcome}`,
    );
  }

  // Slot invariant — when the runner reached the LLM the slot
  // MUST be -1. The runner pins it; we cross-check via the
  // harness adapter's `slotIdSeen`. For gated skips the LLM is
  // never called and `slotIdSeen` stays at its initial NaN —
  // which the harness clamps to REWRITER_SLOT_ID (-1) so the
  // check remains uniform.
  if (
    observed.outcome !== "skipped_not_referential" &&
    observed.outcome !== "skipped_no_history" &&
    observed.slotIdSeen !== -1
  ) {
    failReasons.push(
      `slot invariant violated: rewriter used slot ${observed.slotIdSeen}, expected -1`,
    );
  }

  const expectDiffers =
    c.expectRewriteDiffersFromRaw ?? c.expectedOutcome === "ok";
  if (expectDiffers && observed.rewritten === c.userMessage) {
    failReasons.push(
      `rewrite identical to raw message (expected a different rewritten query)`,
    );
  }
  if (!expectDiffers && observed.rewritten !== c.userMessage) {
    failReasons.push(
      `rewrite expected to equal raw message, observed: ${observed.rewritten.slice(0, 120)}`,
    );
  }
  if (c.expectedSubstring && observed.outcome === "ok") {
    if (
      !observed.rewritten.toLowerCase().includes(c.expectedSubstring.toLowerCase())
    ) {
      failReasons.push(
        `expected substring "${c.expectedSubstring}" missing from rewrite "${observed.rewritten}"`,
      );
    }
  }

  return {
    caseId: c.id,
    label: c.label,
    mode: c.mode,
    expectedOutcome: c.expectedOutcome,
    observedOutcome: observed.outcome,
    rewritten: observed.rewritten,
    rawMessage: c.userMessage,
    pass: failReasons.length === 0,
    failReasons,
    durationMs: observed.durationMs,
    slotIdSeen: observed.slotIdSeen,
  };
}

function aggregate(rows: readonly E9CaseResult[]): E9Aggregate {
  const n = rows.length;
  if (n === 0) {
    return {
      cases: 0,
      passes: 0,
      failures: 0,
      outcomeMatchRate: 0,
      passRate: 0,
      slotInvariantViolations: 0,
    };
  }
  const passes = rows.filter((r) => r.pass).length;
  const outcomeMatches = rows.filter(
    (r) => r.observedOutcome === r.expectedOutcome,
  ).length;
  const slotViolations = rows.filter((r) =>
    r.failReasons.some((reason) => reason.includes("slot invariant violated")),
  ).length;
  return {
    cases: n,
    passes,
    failures: n - passes,
    outcomeMatchRate: outcomeMatches / n,
    passRate: passes / n,
    slotInvariantViolations: slotViolations,
  };
}
