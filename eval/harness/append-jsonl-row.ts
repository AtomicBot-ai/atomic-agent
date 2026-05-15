import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { EvalCase } from "./case-schema.js";
import type { RunCaseResult } from "./run-case.js";

/**
 * Per-case JSONL sidecar. Carries everything the CSV cannot: the user
 * prompt, the full assistant reply, and per-judge verdicts. This is the
 * input format for `npm run eval:judge`, which re-scores saved replies
 * without re-running the agent.
 *
 * On failure (`exitCode !== 0` or `sessionId === null`) we additionally
 * persist a tail of the spawned CLI's stderr/stdout under `diagnostics`.
 * This is the only durable record of the agent's exit reason — the temp
 * workspace (and its trace files) is wiped by `runCase` immediately
 * after we're called. Without this tail, the entire root-cause story
 * for "0-step / 0-token / exitCode 1" failures gets lost forever.
 *
 * The diagnostics block is intentionally absent on success so passing
 * runs stay byte-for-byte identical to schema-1 records.
 */

export interface JsonlRowInput {
  spec: EvalCase;
  result: RunCaseResult;
  jsonlPath: string;
}

const STDERR_TAIL_MAX_LINES = 120;
const STDERR_TAIL_MAX_BYTES = 16 * 1024;
const STDOUT_TAIL_MAX_LINES = 40;
const STDOUT_TAIL_MAX_BYTES = 4 * 1024;

export function appendJsonlRow({
  spec,
  result,
  jsonlPath,
}: JsonlRowInput): void {
  const dir = dirname(jsonlPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const record: Record<string, unknown> = {
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

  const diagnostics = buildDiagnostics(result);
  if (diagnostics !== null) record.diagnostics = diagnostics;

  appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`, "utf8");
}

interface DiagnosticsBlock {
  reason: "exit_code_nonzero" | "no_session_id" | "timed_out";
  signal: NodeJS.Signals | null;
  lastError: string | null;
  stderrTail: string;
  stdoutTail: string;
}

function buildDiagnostics(result: RunCaseResult): DiagnosticsBlock | null {
  if (result.skipped) return null;
  const reason = classifyFailureReason(result);
  if (reason === null) return null;
  return {
    reason,
    signal: result.spawn.signal,
    lastError: result.cli.lastError,
    stderrTail: tailText(result.spawn.stderr, STDERR_TAIL_MAX_LINES, STDERR_TAIL_MAX_BYTES),
    stdoutTail: tailText(result.spawn.stdout, STDOUT_TAIL_MAX_LINES, STDOUT_TAIL_MAX_BYTES),
  };
}

function classifyFailureReason(result: RunCaseResult): DiagnosticsBlock["reason"] | null {
  if (result.spawn.timedOut) return "timed_out";
  if (result.spawn.exitCode !== 0 && result.spawn.exitCode !== null) return "exit_code_nonzero";
  if (result.cli.sessionId === null) return "no_session_id";
  return null;
}

function tailText(input: string, maxLines: number, maxBytes: number): string {
  if (input.length === 0) return "";
  const lines = input.split(/\r?\n/);
  const lastLines = lines.slice(-maxLines);
  let tail = lastLines.join("\n");
  if (tail.length > maxBytes) {
    const overflow = tail.length - maxBytes;
    tail = `[…${overflow} bytes truncated…]\n` + tail.slice(overflow);
  }
  return tail;
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
