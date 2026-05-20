/**
 * E10 — reflection segmentation runner.
 *
 * Drives each scenario through `driveMultiSession` (fresh stateDir
 * per scenario for isolation), parses the CLI subprocess stderr to
 * count `reflection.fired` log entries, and reports cadence stats.
 *
 * The stderr signal is structured: the production runner emits
 *   [<iso>] DEBUG reflection.fired {"sessionId":"<sid>"}
 * once per `ReflectionRunner.reflect` call. We count those lines
 * directly — no need to plumb `AgentMetrics` across the process
 * boundary.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  driveMultiSession,
  type MultiSessionReport,
} from "../../harness/multi-session-driver.js";

import { E10_SCENARIOS, type E10Scenario } from "./dataset.js";

export interface E10ScenarioResult {
  id: string;
  label: string;
  segmentationEnabled: boolean;
  promptsExecuted: number;
  reflectionFires: number;
  expectedFiresMin: number;
  expectedFiresMax: number;
  cadenceOk: boolean;
  stderrTail: string;
  failReasons: readonly string[];
  durationMs: number;
}

export interface E10Aggregate {
  scenarios: number;
  passes: number;
  failures: number;
  /** Ratio (fires segmentation-off / fires segmentation-on). >1 = gate works. */
  cadenceRatio: number | null;
}

export interface E10Report {
  results: readonly E10ScenarioResult[];
  aggregate: E10Aggregate;
}

export interface E10RunnerDeps {
  llamaUrl: string;
}

export interface E10RunnerOptions {
  scenarioIds?: readonly string[];
}

export async function runE10(
  deps: E10RunnerDeps,
  opts: E10RunnerOptions = {},
): Promise<E10Report> {
  const filtered = opts.scenarioIds
    ? E10_SCENARIOS.filter((s) => opts.scenarioIds!.includes(s.id))
    : E10_SCENARIOS;

  const results: E10ScenarioResult[] = [];
  for (const scenario of filtered) {
    results.push(await runScenario(scenario, deps));
  }

  const onRow = results.find((r) => r.id === "segmentation-on");
  const offRow = results.find((r) => r.id === "segmentation-off");
  const cadenceRatio =
    onRow && offRow && onRow.reflectionFires > 0
      ? offRow.reflectionFires / onRow.reflectionFires
      : null;

  return {
    results,
    aggregate: {
      scenarios: results.length,
      passes: results.filter((r) => r.cadenceOk).length,
      failures: results.filter((r) => !r.cadenceOk).length,
      cadenceRatio,
    },
  };
}

async function runScenario(
  scenario: E10Scenario,
  deps: E10RunnerDeps,
): Promise<E10ScenarioResult> {
  const workspace = mkdtempSync(join(tmpdir(), `e10-${scenario.id}-`));
  const stateDir = join(workspace, "state");
  const workingDir = join(workspace, "work");

  const startedAt = Date.now();
  let multi: MultiSessionReport;
  try {
    multi = await driveMultiSession({
      workingDir,
      stateDir,
      llamaUrl: deps.llamaUrl,
      logLevel: "debug",
      segmentationEnabled: scenario.segmentationEnabled,
      steps: [
        {
          kind: "session",
          label: `S1 (${scenario.prompts.length} turns)`,
          prompts: scenario.prompts,
          maxSteps: scenario.maxSteps,
          timeoutMs: scenario.timeoutMs,
        },
      ],
    });
  } catch (err) {
    return {
      id: scenario.id,
      label: scenario.label,
      segmentationEnabled: scenario.segmentationEnabled,
      promptsExecuted: 0,
      reflectionFires: 0,
      expectedFiresMin: scenario.expectedFiresMin,
      expectedFiresMax: scenario.expectedFiresMax,
      cadenceOk: false,
      stderrTail: "",
      failReasons: [
        `driveMultiSession threw: ${err instanceof Error ? err.message : String(err)}`,
      ],
      durationMs: Date.now() - startedAt,
    };
  }

  const sessionStep = multi.steps.find((s) => s.kind === "session");
  if (!sessionStep || sessionStep.kind !== "session") {
    return {
      id: scenario.id,
      label: scenario.label,
      segmentationEnabled: scenario.segmentationEnabled,
      promptsExecuted: 0,
      reflectionFires: 0,
      expectedFiresMin: scenario.expectedFiresMin,
      expectedFiresMax: scenario.expectedFiresMax,
      cadenceOk: false,
      stderrTail: "",
      failReasons: ["session step missing from multi-session report"],
      durationMs: Date.now() - startedAt,
    };
  }

  const stderr = sessionStep.result.stderrAll;
  const fires = countReflectionFires(stderr);
  const promptsExecuted = sessionStep.result.turns.length;
  const failReasons: string[] = [];
  if (
    fires < scenario.expectedFiresMin ||
    fires > scenario.expectedFiresMax
  ) {
    failReasons.push(
      `reflection.fired count=${fires} outside expected [${scenario.expectedFiresMin}, ${scenario.expectedFiresMax}]`,
    );
  }
  if (promptsExecuted < scenario.prompts.length) {
    failReasons.push(
      `only ${promptsExecuted}/${scenario.prompts.length} turns executed (subprocess truncated)`,
    );
  }

  return {
    id: scenario.id,
    label: scenario.label,
    segmentationEnabled: scenario.segmentationEnabled,
    promptsExecuted,
    reflectionFires: fires,
    expectedFiresMin: scenario.expectedFiresMin,
    expectedFiresMax: scenario.expectedFiresMax,
    cadenceOk: failReasons.length === 0,
    stderrTail: sessionStep.result.stderrTail,
    failReasons,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Count `reflection.fired` debug lines in the agent's stderr. The
 * canonical format is:
 *   [<iso>] DEBUG reflection.fired {"sessionId":"..."}
 * Each line corresponds to exactly one `ReflectionRunner.reflect`
 * invocation in the production runner.
 */
export function countReflectionFires(stderr: string): number {
  const re = /\bDEBUG reflection\.fired\b/g;
  let count = 0;
  for (const _ of stderr.matchAll(re)) count += 1;
  return count;
}
