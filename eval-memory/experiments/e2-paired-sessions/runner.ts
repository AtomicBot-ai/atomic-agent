/**
 * E2 — paired-session runner.
 *
 *  1. For each scenario, run it twice (ON / OFF) via the paired
 *     runner, which spawns `atomic-agent run` against fresh state dirs.
 *  2. For each side, extract the scored-turn reply from the trace.
 *  3. Judge both replies against the same rubric (1..5).
 *  4. Report per-scenario `(onScore, offScore, delta, toolCallsDelta,
 *     tokensDelta)` and global aggregates.
 *
 * The "memory works" signal we want from E2:
 *  - `meanOnScore - meanOffScore > 0.4` (judge points, 1..5 scale)
 *  - `winRate(on) >= 0.5` (ON ties or wins at least half the scenarios)
 *  - no scenario worse for ON by ≥1 point (no regressions)
 */

import {
  runPairedScenario,
  type PairedRunOptions,
  type PairedScenarioResult,
} from "../../harness/paired-runner.js";
import { scoreWithRetry, type JudgeClient } from "../../harness/judge.js";

import { PAIRED_SCENARIOS, type PairedScenario } from "./scenarios.js";

export interface PairedScenarioJudgedResult extends PairedScenarioResult {
  scoredTurnIndex: number;
  onReply: string;
  offReply: string;
  onScore: number;
  offScore: number;
  onReason: string;
  offReason: string;
  delta_score: number;
}

export interface E2Aggregate {
  scenarios: number;
  scoredScenarios: number;
  meanOnScore: number;
  meanOffScore: number;
  meanScoreDelta: number;
  winsOn: number;
  ties: number;
  winsOff: number;
  /** Number of scenarios where ON regressed by >= 1 point. */
  regressions: number;
  /** Across all turns of all scenarios, mean tokens delta (on − off). */
  meanPromptTokensDelta: number;
  meanToolCallsDelta: number;
}

export interface E2Report {
  scenarios: readonly PairedScenarioJudgedResult[];
  aggregate: E2Aggregate;
}

export interface E2RunnerDeps {
  judge: JudgeClient;
  pairedRunOptions: PairedRunOptions;
}

export interface E2RunnerOptions {
  scenarioIds?: readonly string[];
  /** Per-scenario hard timeout. Defaults handed straight to PairedRunOptions. */
  timeoutMs?: number;
  maxStepsPerTurn?: number;
}

export async function runE2(deps: E2RunnerDeps, opts: E2RunnerOptions = {}): Promise<E2Report> {
  const selected = opts.scenarioIds
    ? PAIRED_SCENARIOS.filter((s) => opts.scenarioIds!.includes(s.id))
    : PAIRED_SCENARIOS;
  const scenarios: PairedScenarioJudgedResult[] = [];

  for (const s of selected) {
    const scenarioInput: Parameters<typeof runPairedScenario>[0] = {
      id: s.id,
      label: s.label,
      prompts: s.prompts,
    };
    if (opts.maxStepsPerTurn !== undefined) scenarioInput.maxStepsPerTurn = opts.maxStepsPerTurn;
    if (opts.timeoutMs !== undefined) scenarioInput.timeoutMs = opts.timeoutMs;
    const paired = await runPairedScenario(scenarioInput, deps.pairedRunOptions);
    const judged = await judgeScenario(s, paired, deps.judge);
    scenarios.push(judged);
  }

  return { scenarios, aggregate: aggregate(scenarios) };
}

async function judgeScenario(
  s: PairedScenario,
  paired: PairedScenarioResult,
  judge: JudgeClient,
): Promise<PairedScenarioJudgedResult> {
  const onReply = paired.on.run.turns[s.scoredTurnIndex]?.assistantReply ?? "";
  const offReply = paired.off.run.turns[s.scoredTurnIndex]?.assistantReply ?? "";
  const promptText = [
    "Scenario prompts (in order):",
    ...s.prompts.map((p, i) => `${i + 1}. ${p}`),
    "",
    `Scored turn: ${s.scoredTurnIndex + 1}.`,
    `Gold answer (operator-authored): ${s.goldAnswer}`,
  ].join("\n");

  const onVerdict = onReply
    ? await scoreWithRetry(judge, { prompt: promptText, reply: onReply, rubric: s.rubric })
    : { score: 1, reason: "no reply captured on ON side", durationMs: 0, raw: "", parseFallback: false };
  const offVerdict = offReply
    ? await scoreWithRetry(judge, { prompt: promptText, reply: offReply, rubric: s.rubric })
    : { score: 1, reason: "no reply captured on OFF side", durationMs: 0, raw: "", parseFallback: false };

  return {
    ...paired,
    scoredTurnIndex: s.scoredTurnIndex,
    onReply,
    offReply,
    onScore: onVerdict.score,
    offScore: offVerdict.score,
    onReason: onVerdict.reason,
    offReason: offVerdict.reason,
    delta_score: onVerdict.score - offVerdict.score,
  };
}

function aggregate(scenarios: readonly PairedScenarioJudgedResult[]): E2Aggregate {
  if (scenarios.length === 0) {
    return {
      scenarios: 0,
      scoredScenarios: 0,
      meanOnScore: 0,
      meanOffScore: 0,
      meanScoreDelta: 0,
      winsOn: 0,
      ties: 0,
      winsOff: 0,
      regressions: 0,
      meanPromptTokensDelta: 0,
      meanToolCallsDelta: 0,
    };
  }
  const meanOn = scenarios.reduce((s, r) => s + r.onScore, 0) / scenarios.length;
  const meanOff = scenarios.reduce((s, r) => s + r.offScore, 0) / scenarios.length;
  const winsOn = scenarios.filter((r) => r.onScore > r.offScore).length;
  const winsOff = scenarios.filter((r) => r.onScore < r.offScore).length;
  const ties = scenarios.length - winsOn - winsOff;
  const regressions = scenarios.filter((r) => r.offScore - r.onScore >= 1).length;
  const meanTokensDelta = scenarios.reduce((s, r) => s + r.delta.promptTokensDelta, 0) / scenarios.length;
  const meanToolsDelta = scenarios.reduce((s, r) => s + r.delta.toolCallsDelta, 0) / scenarios.length;
  return {
    scenarios: scenarios.length,
    scoredScenarios: scenarios.length,
    meanOnScore: meanOn,
    meanOffScore: meanOff,
    meanScoreDelta: meanOn - meanOff,
    winsOn,
    ties,
    winsOff,
    regressions,
    meanPromptTokensDelta: meanTokensDelta,
    meanToolCallsDelta: meanToolsDelta,
  };
}
