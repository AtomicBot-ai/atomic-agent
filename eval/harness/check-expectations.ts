import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase, EvalExpectation } from "./case-schema.js";
import type { TraceMetrics } from "./parse-trace-metrics.js";
import type { JudgeClient, JudgeVerdict } from "./judge-types.js";

export interface ExpectationFailure {
  kind: EvalExpectation["kind"];
  description: string;
}

export interface ExpectationContext {
  workingDir: string;
  prompt: string;
  reply: string;
  metrics: TraceMetrics;
  judge: JudgeClient | null;
}

export interface JudgeRecord {
  rubric: string;
  threshold: number;
  verdict: JudgeVerdict | null;
  /** True when the judge expectation was treated as failed (no client / parse error / score < threshold). */
  failed: boolean;
  /** Reason the expectation failed, mirrored into ExpectationFailure. */
  failureMessage: string | null;
}

export interface ExpectationCheckResult {
  failures: ExpectationFailure[];
  judgeRecords: JudgeRecord[];
}

const DEFAULT_JUDGE_THRESHOLD = 4;

/**
 * Evaluate every expectation independently and collect failures plus
 * full judge records. The caller treats `failures.length === 0` as
 * success; `judgeRecords` is preserved verbatim so the JSONL sidecar
 * can replay scores for postmortem.
 */
export async function checkExpectations(
  spec: EvalCase,
  ctx: ExpectationContext,
): Promise<ExpectationCheckResult> {
  const failures: ExpectationFailure[] = [];
  const judgeRecords: JudgeRecord[] = [];
  for (const expectation of spec.expectations) {
    if (expectation.kind === "judge") {
      const record = await runJudgeExpectation(expectation, ctx);
      judgeRecords.push(record);
      if (record.failed) {
        failures.push({
          kind: "judge",
          description: record.failureMessage ?? "judge expectation failed",
        });
      }
      continue;
    }
    const failure = checkSyncExpectation(expectation, ctx);
    if (failure) failures.push(failure);
  }
  return { failures, judgeRecords };
}

async function runJudgeExpectation(
  expectation: { kind: "judge"; rubric: string; threshold?: number },
  ctx: ExpectationContext,
): Promise<JudgeRecord> {
  const threshold = expectation.threshold ?? DEFAULT_JUDGE_THRESHOLD;
  if (ctx.judge === null) {
    return {
      rubric: expectation.rubric,
      threshold,
      verdict: null,
      failed: true,
      failureMessage:
        "judge unavailable (set OPENROUTER_API_KEY for the default OpenRouter judge, or override ATOMIC_AGENT_JUDGE_URL)",
    };
  }
  let verdict: JudgeVerdict;
  try {
    verdict = await ctx.judge.score({
      prompt: ctx.prompt,
      reply: ctx.reply,
      rubric: expectation.rubric,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      rubric: expectation.rubric,
      threshold,
      verdict: null,
      failed: true,
      failureMessage: `judge call threw: ${message}`,
    };
  }
  const passed = verdict.score >= threshold;
  return {
    rubric: expectation.rubric,
    threshold,
    verdict,
    failed: !passed,
    failureMessage: passed
      ? null
      : `judge score ${verdict.score}/${threshold}: ${verdict.reason.slice(0, 160)}`,
  };
}

function checkSyncExpectation(
  expectation: Exclude<EvalExpectation, { kind: "judge" }>,
  ctx: ExpectationContext,
): ExpectationFailure | null {
  switch (expectation.kind) {
    case "reply_contains": {
      if (expectation.pattern.test(ctx.reply)) return null;
      return {
        kind: expectation.kind,
        description: `reply did not match ${expectation.pattern}`,
      };
    }
    case "file_exists": {
      const fullPath = join(ctx.workingDir, expectation.path);
      if (existsSync(fullPath)) return null;
      return {
        kind: expectation.kind,
        description: `expected file not found: ${expectation.path}`,
      };
    }
    case "file_matches": {
      const fullPath = join(ctx.workingDir, expectation.path);
      if (!existsSync(fullPath)) {
        return {
          kind: expectation.kind,
          description: `file_matches: file missing: ${expectation.path}`,
        };
      }
      const content = readFileSync(fullPath, "utf8");
      if (expectation.pattern.test(content)) return null;
      return {
        kind: expectation.kind,
        description: `file ${expectation.path} did not match ${expectation.pattern}`,
      };
    }
    case "tool_invoked": {
      const matches = ctx.metrics.toolInvocations.filter(
        (i) => i.tool === expectation.tool,
      );
      if (matches.length === 0) {
        return {
          kind: expectation.kind,
          description: `tool never invoked: ${expectation.tool}`,
        };
      }
      if (expectation.mustSucceed && !matches.some((m) => m.status === "ok")) {
        return {
          kind: expectation.kind,
          description: `tool ${expectation.tool} was invoked but every call errored`,
        };
      }
      return null;
    }
    case "tool_not_invoked": {
      const matches = ctx.metrics.toolInvocations.filter(
        (i) => i.tool === expectation.tool,
      );
      if (matches.length === 0) return null;
      return {
        kind: expectation.kind,
        description: `tool ${expectation.tool} must NOT have been invoked, but it ran ${matches.length} time(s)`,
      };
    }
    case "step_count": {
      const steps = ctx.metrics.stepCount;
      if (expectation.max !== undefined && steps > expectation.max) {
        return {
          kind: expectation.kind,
          description: `step_count: expected <= ${expectation.max}, got ${steps}`,
        };
      }
      if (expectation.min !== undefined && steps < expectation.min) {
        return {
          kind: expectation.kind,
          description: `step_count: expected >= ${expectation.min}, got ${steps}`,
        };
      }
      return null;
    }
    case "parse_retries_max": {
      const retries = ctx.metrics.parseRetries;
      if (retries <= expectation.max) return null;
      return {
        kind: expectation.kind,
        description: `parse_retries: expected <= ${expectation.max}, got ${retries}`,
      };
    }
    case "batch_size_min": {
      const max = ctx.metrics.maxBatchSize;
      if (max >= expectation.min) return null;
      return {
        kind: expectation.kind,
        description: `batch_size_min: expected at least one batch of size >= ${expectation.min}, observed max ${max}`,
      };
    }
    default: {
      const _exhaustive: never = expectation;
      return _exhaustive;
    }
  }
}
