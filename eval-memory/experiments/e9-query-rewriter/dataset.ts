/**
 * E9 — query rewriter (v2.5 Phase A) dataset.
 *
 * Each case exercises one branch of the rewriter outcome taxonomy
 * (see `query-rewriter-runner.ts`). The harness drives a real
 * `QueryRewriterRunner` against a managed llama-server for the
 * "live" cases, and an injected stub for the failure-mode cases
 * (`malformed`).
 */

import type { RewriterHistoryTurn } from "../../../src/memory/retrieve/index.js";
import type { RewriterOutcome } from "../../../src/memory/retrieve/index.js";

/**
 * One scenario case.
 *
 * - `mode = "live"` — runner uses the managed daemon's
 *   `llmComplete`.
 * - `mode = "stub"` — runner uses a synthetic completion the case
 *   supplies (used for `failed` / parser-rejection branches).
 * - `mode = "timeout"` — runner uses `timeoutMs = 1` against the
 *   live daemon so the deadline trips before the model can reply.
 */
export type Mode = "live" | "stub" | "timeout";

export interface RewriterCase {
  id: string;
  label: string;
  mode: Mode;
  /** Optional stub body for `mode === "stub"`. Required when so. */
  stubCompletion?: string;
  /** Override the harness default `timeoutMs` (60s). */
  timeoutMs?: number;
  userMessage: string;
  history: ReadonlyArray<RewriterHistoryTurn>;
  /**
   * Expected outcome. The runner reports it through its metrics
   * callback; the spec asserts on this field directly.
   */
  expectedOutcome: RewriterOutcome;
  /**
   * Optional substring that must appear in the rewritten output
   * when the outcome is `ok`. Skipped for non-`ok` cases.
   * Tolerant — the model has room to phrase the rewrite however
   * it wants, we only check that the resolved referent is in.
   */
  expectedSubstring?: string;
  /**
   * When true, also require that `rewritten !== userMessage` (the
   * runner returned a real rewrite, not the raw message). Defaults
   * to `true` for `ok`, `false` otherwise.
   */
  expectRewriteDiffersFromRaw?: boolean;
}

export const REWRITER_CASES: readonly RewriterCase[] = [
  {
    id: "ref-pronoun-it",
    label: "short pronoun follow-up resolves the antecedent",
    mode: "live",
    userMessage: "how do I enable it?",
    history: [
      {
        role: "user",
        text: "what is the FTS5 ranking algorithm used by SQLite?",
      },
      {
        role: "assistant",
        text:
          "FTS5 uses the bm25() ranking function by default. You can swap it out at virtual-table creation time.",
      },
    ],
    expectedOutcome: "ok",
    expectedSubstring: "fts5",
  },
  {
    id: "ref-conjunction-starter",
    label: "conjunction starter triggers the gate and produces a rewrite",
    mode: "live",
    userMessage: "and what about timezones?",
    history: [
      {
        role: "user",
        text: "remember that I prefer 24-hour clock format in scheduled summaries.",
      },
      {
        role: "assistant",
        text: "Got it — scheduled summaries will use a 24-hour clock for time stamps.",
      },
    ],
    expectedOutcome: "ok",
    expectedSubstring: "summaries",
  },
  {
    id: "nonref-long-self-contained",
    label: "long self-contained message bypasses the LLM (skip)",
    mode: "live",
    userMessage:
      "Please open the document at /tmp/contracts/q4-2025.docx and extract the renewal date plus the counterparty name, then store both in profile as separate facts.",
    history: [
      {
        role: "user",
        text: "first task of the morning",
      },
      {
        role: "assistant",
        text: "Ready when you are.",
      },
    ],
    expectedOutcome: "skipped_not_referential",
    expectRewriteDiffersFromRaw: false,
  },
  {
    id: "nonref-question-word",
    label: "short message but contains 'what' — question word disambiguates",
    mode: "live",
    userMessage: "what is fts5?",
    history: [
      {
        role: "user",
        text: "let's switch topic",
      },
      {
        role: "assistant",
        text: "Sure, what's next?",
      },
    ],
    expectedOutcome: "skipped_not_referential",
    expectRewriteDiffersFromRaw: false,
  },
  {
    id: "empty-history",
    label: "first turn (history empty) skips by definition",
    mode: "live",
    userMessage: "tell me more about it",
    history: [],
    expectedOutcome: "skipped_no_history",
    expectRewriteDiffersFromRaw: false,
  },
  {
    id: "live-timeout",
    label: "1ms hard deadline trips before live llama-server replies",
    mode: "timeout",
    timeoutMs: 1,
    userMessage: "and the other one?",
    history: [
      {
        role: "user",
        text: "i was comparing FTS5 to Lucene for full-text recall",
      },
      {
        role: "assistant",
        text: "Both are mature; the trade-off is footprint vs. JVM tooling.",
      },
    ],
    expectedOutcome: "timeout",
    expectRewriteDiffersFromRaw: false,
  },
  {
    id: "stub-malformed-empty",
    label: "stub returns empty body — parser rejects, outcome=failed",
    mode: "stub",
    stubCompletion: "",
    userMessage: "what about it?",
    history: [
      {
        role: "user",
        text: "do you remember the chokidar one-shot helper?",
      },
      {
        role: "assistant",
        text: "Yes — it wraps a single fs event with a timeout cap.",
      },
    ],
    expectedOutcome: "failed",
    expectRewriteDiffersFromRaw: false,
  },
  {
    id: "stub-no-envelope",
    label: "stub omits the envelope tag — parser rejects, outcome=failed",
    mode: "stub",
    stubCompletion: "plain text without the required envelope tag",
    userMessage: "and that one?",
    history: [
      {
        role: "user",
        text: "i mentioned the cron parser earlier",
      },
      {
        role: "assistant",
        text: "Right, it lives in src/tasks/task-schedule.ts.",
      },
    ],
    expectedOutcome: "failed",
    expectRewriteDiffersFromRaw: false,
  },
  {
    id: "stub-abstain-token",
    label: "stub returns NONE abstain token — outcome=failed (caller falls back)",
    mode: "stub",
    stubCompletion: "<rewritten_query>NONE</rewritten_query>",
    userMessage: "and the second one?",
    history: [
      {
        role: "user",
        text: "i was reading about referential queries",
      },
      {
        role: "assistant",
        text: "Referential queries skip the long-form context.",
      },
    ],
    expectedOutcome: "failed",
    expectRewriteDiffersFromRaw: false,
  },
];

export function findCase(id: string): RewriterCase {
  const c = REWRITER_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`rewriter case not found: ${id}`);
  return c;
}
