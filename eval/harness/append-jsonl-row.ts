import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { EvalCase } from "./case-schema.js";
import type { RunCaseResult } from "./run-case.js";

/**
 * Per-case JSONL sidecar. Carries everything the CSV cannot: the user
 * prompt, the full assistant reply, and per-judge verdicts. This is the
 * input format for `npm run eval:judge`, which re-scores saved replies
 * without re-running the agent.
 */

export interface JsonlRowInput {
  spec: EvalCase;
  result: RunCaseResult;
  jsonlPath: string;
}

export function appendJsonlRow({
  spec,
  result,
  jsonlPath,
}: JsonlRowInput): void {
  const dir = dirname(jsonlPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const record = {
    schema: 1,
    ts: new Date().toISOString(),
    case: {
      id: spec.id,
      name: spec.name,
      category: spec.category,
      capabilityAxis: spec.capabilityAxis ?? null,
      prompt: spec.prompt,
    },
    expectations: spec.expectations.map((e) => summariseExpectation(e)),
    run: {
      passed: result.passed,
      skipped: result.skipped,
      skipReason: result.skipReason,
      durationMs: result.spawn.durationMs,
      exitCode: result.spawn.exitCode,
      timedOut: result.spawn.timedOut,
      sessionId: result.cli.sessionId,
      sessionStatus: result.cli.sessionStatus,
      reply: result.cli.reply,
    },
    metrics: {
      stepCount: result.metrics.stepCount,
      promptTokens: result.metrics.totalPromptTokens,
      predictedTokens: result.metrics.totalPredictedTokens,
      cacheHits: result.metrics.cacheHits,
      parseRetries: result.metrics.parseRetries,
      toolErrors: result.metrics.toolErrorCount,
      batchCount: result.metrics.batchCount,
      maxBatchSize: result.metrics.maxBatchSize,
      tools: result.metrics.toolInvocations,
      failureCategory: result.metrics.failureCategory,
    },
    failures: result.failures,
    judgeRecords: result.judgeRecords,
  };
  appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`, "utf8");
}

function summariseExpectation(e: EvalCase["expectations"][number]): unknown {
  switch (e.kind) {
    case "reply_contains":
      return { kind: e.kind, pattern: e.pattern.source };
    case "file_exists":
      return { kind: e.kind, path: e.path };
    case "file_matches":
      return { kind: e.kind, path: e.path, pattern: e.pattern.source };
    case "tool_invoked":
      return { kind: e.kind, tool: e.tool, mustSucceed: e.mustSucceed ?? false };
    case "tool_not_invoked":
      return { kind: e.kind, tool: e.tool };
    case "step_count":
      return { kind: e.kind, max: e.max ?? null, min: e.min ?? null };
    case "parse_retries_max":
      return { kind: e.kind, max: e.max };
    case "batch_size_min":
      return { kind: e.kind, min: e.min };
    case "judge":
      return { kind: e.kind, rubric: e.rubric, threshold: e.threshold ?? 4 };
    default: {
      const _exhaustive: never = e;
      return _exhaustive;
    }
  }
}
