import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { EvalCase } from "./case-schema.js";
import type { RunCaseResult } from "./run-case.js";

/**
 * One CSV row per case, appended to a daily file. Stable additive
 * schema: new columns are always appended so existing pandas/sqlite
 * consumers keep working.
 *
 * Columns:
 *   ts, case_id, category, status, duration_ms, steps,
 *   prompt_tokens, predicted_tokens, cache_hits, parse_retries,
 *   tools_used, failures, failure_category,
 *   judge_count, judge_avg_score, judge_pass_rate
 *
 * Where:
 *   status         = pass | fail | skip
 *   tools_used     = "|" separated tool:status pairs
 *   failures       = "|" separated short descriptions (truncated)
 *   judge_count    = number of judge expectations the case had (0 if none)
 *   judge_avg_score = mean over verdicts that produced a numeric score
 *                     (empty when judge_count=0 or every call failed)
 *   judge_pass_rate = passed / total verdicts (empty when judge_count=0)
 */

const HEADER = [
  "ts",
  "case_id",
  "category",
  "status",
  "duration_ms",
  "steps",
  "prompt_tokens",
  "predicted_tokens",
  "cache_hits",
  "parse_retries",
  "tools_used",
  "failures",
  "failure_category",
  "judge_count",
  "judge_avg_score",
  "judge_pass_rate",
].join(",");

export interface ReportRowInput {
  spec: EvalCase;
  result: RunCaseResult;
  reportPath: string;
}

export function appendReportRow({ spec, result, reportPath }: ReportRowInput): void {
  const dir = dirname(reportPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(reportPath)) writeFileSync(reportPath, `${HEADER}\n`, "utf8");

  const status = result.skipped ? "skip" : result.passed ? "pass" : "fail";
  const tools = result.metrics.toolInvocations
    .map((t) => `${t.tool}:${t.status}`)
    .join("|");
  const failures = result.failures.map((f) => f.description).join("|");

  const judgeCount = result.judgeRecords.length;
  const numericVerdicts = result.judgeRecords
    .map((r) => r.verdict?.score)
    .filter((s): s is number => typeof s === "number");
  const judgeAvg =
    numericVerdicts.length === 0
      ? ""
      : (
          numericVerdicts.reduce((acc, n) => acc + n, 0) / numericVerdicts.length
        ).toFixed(2);
  const judgePassRate =
    judgeCount === 0
      ? ""
      : (
          result.judgeRecords.filter((r) => !r.failed).length / judgeCount
        ).toFixed(2);

  const row = [
    new Date().toISOString(),
    spec.id,
    spec.category,
    status,
    result.spawn.durationMs.toString(),
    result.metrics.stepCount.toString(),
    result.metrics.totalPromptTokens.toString(),
    result.metrics.totalPredictedTokens.toString(),
    result.metrics.cacheHits.toString(),
    result.metrics.parseRetries.toString(),
    csvEscape(tools),
    csvEscape(failures),
    result.metrics.failureCategory ?? "",
    judgeCount.toString(),
    judgeAvg,
    judgePassRate,
  ].join(",");

  appendFileSync(reportPath, `${row}\n`, "utf8");
}

function csvEscape(value: string): string {
  if (value === "") return "";
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
