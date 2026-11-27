import { getConfig } from "../config/index.js";
import { formatCouncilReport, type CouncilReport } from "../llm/toolcall-bench/index.js";
import { runRuntimeCouncil } from "../runtime/council-service.js";
import { readCliOption } from "./models-handlers.js";
import type { ModelsBenchDeps } from "./models-toolcall-bench.js";

const USAGE =
  'usage: atomic-agent models council "<question>" [--models <provider[:model]>[*N],...] [--judge <spec>]\n' +
  "         [--chairman <spec> | --no-chairman] [--no-rank] [--max-usd <n>] [--dry-run] [--json]\n";

/** Flags that take a value; their value is not part of the question. */
const VALUE_FLAGS = new Set(["--models", "--judge", "--chairman", "--max-usd"]);
/** Flags on their own. */
const BARE_FLAGS = new Set(["--json", "--council", "--no-rank", "--no-chairman", "--dry-run"]);

export type { CouncilReport };

/** The words of `args` that are not council flags or their values, joined. */
export function councilQuestionOf(args: readonly string[]): string {
  const words: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (BARE_FLAGS.has(arg)) continue;
    words.push(arg);
  }
  return words.join(" ").trim();
}

/** `--max-usd 0.5` as a number; `null` for a value that is not a non-negative number. */
export function parseMaxUsd(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const value = Number(raw.trim().replace(/^\$/, ""));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * `atomic-agent models council "<question>" [--models a,b*2] [--judge c]
 * [--chairman d | --no-chairman] [--no-rank] [--max-usd n] [--dry-run] [--json]`,
 * also reached as `models ask --council` (ATO-2232, ATO-2432).
 *
 * The council of `runCouncil`: every seat answers, the judge lists Agree /
 * Disagree / Unique, every member ranks the others' answers (names hidden),
 * and the chairman writes the final answer. `model*N` seats one model N
 * times (Self-MoA); no `--models` seats the active provider three times.
 * The cost forecast goes to stderr before anything is sent; over
 * `--max-usd` nothing is sent, and `--dry-run` only prints the forecast.
 *
 * Exit 0 with a verdict, or with a single answer (nothing to compare);
 * 1 when every model failed, the judge or the chairman failed, or the
 * forecast is over the limit; 2 for a usage error.
 */
export async function runModelsCouncil(
  args: readonly string[],
  deps: ModelsBenchDeps = {},
): Promise<number> {
  const write = deps.write ?? ((t: string) => process.stdout.write(t));
  const writeErr = deps.writeErr ?? ((t: string) => process.stderr.write(t));
  const question = councilQuestionOf(args);
  const maxUsd = parseMaxUsd(readCliOption([...args], "--max-usd"));
  if (question === "" || maxUsd === null) {
    writeErr(USAGE);
    return 2;
  }
  const json = args.includes("--json");
  const chairman = args.includes("--no-chairman") ? null : readCliOption([...args], "--chairman")?.trim();
  const models = readCliOption([...args], "--models");
  const judge = readCliOption([...args], "--judge")?.trim();
  const result = await runRuntimeCouncil(
    {
      question,
      ...(models !== undefined ? { models } : {}),
      ...(judge ? { judge } : {}),
      ...(chairman === null ? { chairman: null } : chairman ? { chairman } : {}),
      rank: !args.includes("--no-rank"),
      ...(maxUsd !== undefined ? { maxUsd } : {}),
      forecastOnly: args.includes("--dry-run"),
      onForecast: (line) => writeErr(`${line}\n`),
    },
    { config: deps.config ?? getConfig(), ...(deps.build ? { build: deps.build } : {}) },
  );
  for (const line of result.skipped ?? []) writeErr(`skipped ${line}\n`);
  if (!result.ok) {
    writeErr(`${result.reason}\n`);
    return 1;
  }
  const report = result.report;
  if (!report) {
    if (json) write(`${JSON.stringify({ question, forecast: result.forecast })}\n`);
    return 0;
  }
  for (const note of report.notes) writeErr(`${note}\n`);
  if (report.judgeError !== undefined) writeErr(`judge ${report.judge} failed: ${report.judgeError}\n`);
  if (report.chairman?.error !== undefined) writeErr(`chairman ${report.chairman.model} failed: ${report.chairman.error}\n`);
  if (json) write(`${JSON.stringify({ ...report, forecast: result.forecast })}\n`);
  else write(formatCouncilReport(report, { notes: false }));
  const answered = report.answers.some((a) => a.error === undefined && (a.text ?? "").trim() !== "");
  if (!answered || report.judgeError !== undefined || report.chairman?.error !== undefined) return 1;
  return 0;
}
