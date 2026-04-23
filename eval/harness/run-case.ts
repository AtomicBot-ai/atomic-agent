import { join } from "node:path";

import type { EvalCase } from "./case-schema.js";
import { spawnAgentRun, type SpawnAgentResult } from "./spawn-agent.js";
import { parseCliOutput, type ParsedCliOutput } from "./parse-cli-output.js";
import {
  collectTraceMetrics,
  type TraceMetrics,
} from "./parse-trace-metrics.js";
import {
  checkExpectations,
  type ExpectationFailure,
  type JudgeRecord,
} from "./check-expectations.js";
import {
  createTempWorkspace,
  type TempWorkspace,
} from "./temp-workspace.js";
import { installEvalSkills } from "./install-eval-skills.js";
import type { JudgeClient } from "./judge-types.js";

export interface RunCaseDependencies {
  /** URL of the eval-local mock HTTP server, when started. */
  mockHttpUrl: string | null;
  /** Optional judge client; required iff a case has `judge` expectations. */
  judge: JudgeClient | null;
  /** Hard timeout per case (ms). Defaults to 120s. */
  timeoutMs?: number;
  /** Override config.agent.maxSteps (also passed to the CLI). */
  defaultMaxSteps?: number;
}

export interface RunCaseResult {
  caseId: string;
  passed: boolean;
  spawn: SpawnAgentResult;
  cli: ParsedCliOutput;
  metrics: TraceMetrics;
  failures: ExpectationFailure[];
  judgeRecords: JudgeRecord[];
  /** Path to the trace file we read (for postmortem). */
  tracePath: string | null;
  /** True when the case was skipped because its `requires` were unmet. */
  skipped: boolean;
  skipReason: string | null;
}

/**
 * End-to-end execution of a single eval case. See `eval/README.md` for
 * the high-level flow. Judge expectations are evaluated inline so the
 * vitest test fails on judge-rejected replies just like on regex
 * mismatches.
 */
export async function runCase(
  spec: EvalCase,
  deps: RunCaseDependencies,
): Promise<RunCaseResult> {
  const skipReason = checkRequirements(spec, deps);
  if (skipReason !== null) {
    return makeSkipped(spec.id, skipReason);
  }

  const workspace: TempWorkspace = createTempWorkspace(spec.id);
  try {
    installEvalSkills(workspace.stateDir);
    if (spec.setup) {
      await spec.setup({
        workingDir: workspace.workingDir,
        stateDir: workspace.stateDir,
        mockHttpUrl: deps.mockHttpUrl,
      });
    }

    const maxSteps = spec.maxSteps ?? deps.defaultMaxSteps ?? 15;
    const spawn = await spawnAgentRun({
      workingDir: workspace.workingDir,
      stateDir: workspace.stateDir,
      prompt: spec.prompt,
      maxSteps,
      timeoutMs: deps.timeoutMs ?? 120_000,
    });

    const cli = parseCliOutput(spawn.stdout, spawn.stderr);

    let tracePath: string | null = null;
    let metrics: TraceMetrics = emptyMetrics();
    if (cli.sessionId !== null) {
      tracePath = join(workspace.stateDir, "traces", `${cli.sessionId}.ndjson`);
      metrics = await collectTraceMetrics(tracePath);
    }

    const { failures, judgeRecords } = await checkExpectations(spec, {
      workingDir: workspace.workingDir,
      prompt: spec.prompt,
      reply: cli.reply,
      metrics,
      judge: deps.judge,
    });

    return {
      caseId: spec.id,
      passed: failures.length === 0 && spawn.exitCode === 0 && !spawn.timedOut,
      spawn,
      cli,
      metrics,
      failures,
      judgeRecords,
      tracePath,
      skipped: false,
      skipReason: null,
    };
  } finally {
    workspace.cleanup();
  }
}

function checkRequirements(
  spec: EvalCase,
  deps: RunCaseDependencies,
): string | null {
  if (!spec.requires) return null;
  for (const requirement of spec.requires) {
    if (requirement === "mock-http" && deps.mockHttpUrl === null) {
      return "mock-http server not started";
    }
  }
  return null;
}

function emptyMetrics(): TraceMetrics {
  return {
    found: false,
    stepCount: 0,
    totalPromptTokens: 0,
    totalPredictedTokens: 0,
    cacheHits: 0,
    parseRetries: 0,
    loopDetected: 0,
    toolInvocations: [],
    failureCategory: null,
    failureMessage: null,
  };
}

function makeSkipped(caseId: string, reason: string): RunCaseResult {
  return {
    caseId,
    passed: false,
    spawn: {
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: 0,
    },
    cli: {
      reply: "",
      sessionId: null,
      sessionStatus: null,
      stepCount: null,
      lastError: null,
    },
    metrics: emptyMetrics(),
    failures: [],
    judgeRecords: [],
    tracePath: null,
    skipped: true,
    skipReason: reason,
  };
}
