/**
 * E3 — reflection signal-to-noise runner.
 *
 *  1. For each dataset pair, call the reflection LLM in isolation
 *     (`runIsolatedReflection`) — bypasses ProfileStore/MemoryStore so
 *     we are only measuring the LLM's extraction quality.
 *  2. For each parsed entry (SET / NOTE / EVOLVE), build a judge
 *     prompt that includes the pair's rubric and ask the judge to
 *     score it 1..5.
 *  3. Bucket per case: `useful >=4 / trivia 2-3 / wrong <=1` AND
 *     count `expected_none` pairs where reflection helpfully output
 *     NONE (perfect) vs erroneously emitted entries (noise).
 *  4. Aggregate: per-case + global usefulness fraction, wrongness
 *     fraction, NONE-handling rate.
 */

import type {
  ParsedReflection,
  ReflectionFact,
  ReflectionNote,
} from "../../../src/memory/reflection/index.js";
import type { ReflectionEvolve } from "../../../src/memory/reflection/reflection-parser.js";

import { runIsolatedReflection } from "../../harness/reflection-isolated.js";
import type { LlmCompleteFn } from "../../harness/reflection-isolated.js";
import { scoreWithRetry, type JudgeClient } from "../../harness/judge.js";

import {
  REFLECTION_AUDIT_CASES,
  type ReflectionAuditCase,
} from "./dataset.js";

export type GradedEntryKind = "set" | "note" | "evolve";

export interface GradedEntry {
  caseId: string;
  kind: GradedEntryKind;
  /** Free-form textual representation passed to the judge. */
  rendered: string;
  score: number;
  reason: string;
  judgeMs: number;
}

export interface CaseResult {
  caseId: string;
  label: string;
  expectation: ReflectionAuditCase["expectation"];
  /** What the reflection LLM produced. */
  parsed: ParsedReflection;
  raw: string;
  reasoning: string;
  durationMs: number;
  /** One row per extracted entry. Empty when parsed.kind === "none". */
  graded: readonly GradedEntry[];
  /** True when the case's expectation is met (e.g. expected_none && parsed.kind === "none"). */
  expectationMet: boolean;
}

export interface E3Aggregate {
  cases: number;
  entries: number;
  usefulEntries: number;
  triviaEntries: number;
  wrongEntries: number;
  /** P(useful) — entries with score ≥ 4 over all entries. */
  usefulnessRate: number;
  /** P(wrong) — entries with score ≤ 1 over all entries. */
  wrongnessRate: number;
  /** Fraction of `expects_none` cases that produced NONE. */
  noneCorrectness: number;
  /** Average per-entry judge score across all entries. */
  meanScore: number;
}

export interface E3Report {
  cases: readonly CaseResult[];
  aggregate: E3Aggregate;
}

export interface E3RunnerDeps {
  llmComplete: LlmCompleteFn;
  judge: JudgeClient;
}

export interface E3RunnerOptions {
  /** Optional filter to a subset of case ids (debug / focused reruns). */
  caseIds?: readonly string[];
  /** Reflection temperature override. */
  temperature?: number;
  /** Per-case wall-clock timeout (ms). Defaults to 60 s. */
  timeoutMs?: number;
}

export async function runE3(deps: E3RunnerDeps, opts: E3RunnerOptions = {}): Promise<E3Report> {
  const selected = opts.caseIds
    ? REFLECTION_AUDIT_CASES.filter((c) => opts.caseIds!.includes(c.id))
    : REFLECTION_AUDIT_CASES;
  const cases: CaseResult[] = [];

  for (const c of selected) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
    try {
      const reflectDeps: Parameters<typeof runIsolatedReflection>[1] = {
        llmComplete: deps.llmComplete,
      };
      if (opts.temperature !== undefined) reflectDeps.temperature = opts.temperature;
      const result = await runIsolatedReflection(
        {
          userMessage: c.userMessage,
          assistantReply: c.assistantReply,
          sessionId: `e3-${c.id}`,
          signal: controller.signal,
        },
        reflectDeps,
      );

      const graded = await gradeEntries(c, result.parsed, deps.judge);
      cases.push({
        caseId: c.id,
        label: c.label,
        expectation: c.expectation,
        parsed: result.parsed,
        raw: result.raw,
        reasoning: result.reasoning,
        durationMs: result.durationMs,
        graded,
        expectationMet: meetsExpectation(c.expectation, result.parsed, graded),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return { cases, aggregate: aggregate(cases) };
}

function meetsExpectation(
  expectation: ReflectionAuditCase["expectation"],
  parsed: ParsedReflection,
  graded: readonly GradedEntry[],
): boolean {
  if (expectation === "expects_none") return parsed.kind === "none";
  if (expectation === "expects_one_useful") {
    return graded.some((g) => g.score >= 4);
  }
  return graded.length > 0 && graded.some((g) => g.score >= 4);
}

function aggregate(cases: readonly CaseResult[]): E3Aggregate {
  const allEntries = cases.flatMap((c) => c.graded);
  const useful = allEntries.filter((g) => g.score >= 4).length;
  const trivia = allEntries.filter((g) => g.score >= 2 && g.score <= 3).length;
  const wrong = allEntries.filter((g) => g.score <= 1).length;
  const noneCases = cases.filter((c) => c.expectation === "expects_none");
  const noneCorrect = noneCases.filter((c) => c.parsed.kind === "none").length;
  const sum = allEntries.reduce((s, g) => s + g.score, 0);
  return {
    cases: cases.length,
    entries: allEntries.length,
    usefulEntries: useful,
    triviaEntries: trivia,
    wrongEntries: wrong,
    usefulnessRate: allEntries.length === 0 ? 1 : useful / allEntries.length,
    wrongnessRate: allEntries.length === 0 ? 0 : wrong / allEntries.length,
    noneCorrectness: noneCases.length === 0 ? 1 : noneCorrect / noneCases.length,
    meanScore: allEntries.length === 0 ? 0 : sum / allEntries.length,
  };
}

async function gradeEntries(
  c: ReflectionAuditCase,
  parsed: ParsedReflection,
  judge: JudgeClient,
): Promise<readonly GradedEntry[]> {
  if (parsed.kind === "none") return [];
  const out: GradedEntry[] = [];
  for (const fact of parsed.facts) out.push(await gradeFact(c, fact, judge));
  for (const note of parsed.notes) out.push(await gradeNote(c, note, judge));
  for (const evolve of parsed.evolves) out.push(await gradeEvolve(c, evolve, judge));
  return out;
}

async function gradeFact(
  c: ReflectionAuditCase,
  fact: ReflectionFact,
  judge: JudgeClient,
): Promise<GradedEntry> {
  const pinnedSuffix = fact.pinned === false ? ` [pinned=false; keywords=${(fact.keywords ?? []).join(",")}]` : "";
  const rendered = `SET ${fact.key}=${fact.value}${pinnedSuffix}`;
  return gradeOne(c, "set", rendered, judge);
}

async function gradeNote(
  c: ReflectionAuditCase,
  note: ReflectionNote,
  judge: JudgeClient,
): Promise<GradedEntry> {
  const tagSuffix = note.tags && note.tags.length > 0 ? ` [tags=${note.tags.join(",")}]` : "";
  const rendered = `NOTE ${note.body}${tagSuffix}`;
  return gradeOne(c, "note", rendered, judge);
}

async function gradeEvolve(
  c: ReflectionAuditCase,
  evolve: ReflectionEvolve,
  judge: JudgeClient,
): Promise<GradedEntry> {
  const rendered = `EVOLVE #${evolve.targetId} [tags=${evolve.addTags.join(",")}]`;
  return gradeOne(c, "evolve", rendered, judge);
}

async function gradeOne(
  c: ReflectionAuditCase,
  kind: GradedEntryKind,
  rendered: string,
  judge: JudgeClient,
): Promise<GradedEntry> {
  const prompt = [
    "== USER MESSAGE ==",
    c.userMessage,
    "",
    "== ASSISTANT REPLY ==",
    c.assistantReply,
    "",
    "== EXTRACTED ENTRY ==",
    rendered,
    "",
    "Score this entry under the rubric. Be strict: durable, specific, and accurate = high; transient, generic, or contradictory = low.",
  ].join("\n");
  const verdict = await scoreWithRetry(judge, {
    prompt,
    reply: rendered,
    rubric: c.rubric,
  });
  return {
    caseId: c.id,
    kind,
    rendered,
    score: verdict.score,
    reason: verdict.reason,
    judgeMs: verdict.durationMs,
  };
}
