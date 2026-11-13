import {
  BENCH_CASES,
  BENCH_SYSTEM_HINT,
  BENCH_TOOLS,
  type BenchCase,
  type BenchTool,
} from "./bench-cases.js";
import { scoreToolCall, type TryOutcome, type TryReply } from "./score-tool-call.js";

/** One bench request: the prompt text and the toolbox it may call. */
export interface BenchRequest {
  prompt: string;
  tools: readonly BenchTool[];
}

/**
 * Send one request to one model. Injected so the bench is testable with
 * fakes and knows nothing about providers; it may throw, which counts as
 * an `error` try.
 */
export type BenchComplete = (model: string, request: BenchRequest) => Promise<TryReply>;

export interface ModelBenchResult {
  model: string;
  tries: number;
  /** Tries whose call carried a JSON object as arguments. */
  validJson: number;
  /** Tries that called the case's tool (with valid JSON). */
  rightTool: number;
  /** Tries that called the right tool with every required argument. */
  argsOk: number;
  parseFailures: number;
  noCall: number;
  errors: number;
  /** Mean wall time of a try, errors included. */
  avgMs: number;
  /** `ok` tries per case id, to show which prompt a model trips on. */
  okByCase: Record<string, number>;
  /** First error message seen, so a dead model says why. */
  firstError?: string;
}

export interface RunToolCallBenchOptions {
  models: readonly string[];
  tries: number;
  complete: BenchComplete;
  cases?: readonly BenchCase[];
  now?: () => number;
  onTry?: (event: { model: string; caseId: string; attempt: number; outcome: TryOutcome }) => void;
}

function emptyResult(model: string, cases: readonly BenchCase[]): ModelBenchResult {
  return {
    model,
    tries: 0,
    validJson: 0,
    rightTool: 0,
    argsOk: 0,
    parseFailures: 0,
    noCall: 0,
    errors: 0,
    avgMs: 0,
    okByCase: Object.fromEntries(cases.map((c) => [c.id, 0])),
  };
}

function count(result: ModelBenchResult, caseId: string, outcome: TryOutcome): void {
  result.tries += 1;
  if (outcome === "error") result.errors += 1;
  if (outcome === "no_call") result.noCall += 1;
  if (outcome === "parse_failure") result.parseFailures += 1;
  if (outcome === "wrong_tool" || outcome === "missing_args" || outcome === "ok") {
    result.validJson += 1;
  }
  if (outcome === "missing_args" || outcome === "ok") result.rightTool += 1;
  if (outcome === "ok") {
    result.argsOk += 1;
    result.okByCase[caseId] = (result.okByCase[caseId] ?? 0) + 1;
  }
}

/**
 * Run every case `tries` times against every model and count the
 * outcomes (ATO-1092). Strictly one request at a time: a local server
 * usually has one slot, and a cloud key has rate limits, so parallel
 * tries would measure queueing instead of the model.
 */
export async function runToolCallBench(
  options: RunToolCallBenchOptions,
): Promise<ModelBenchResult[]> {
  const cases = options.cases ?? BENCH_CASES;
  const now = options.now ?? Date.now;
  const tries = Math.max(1, Math.floor(options.tries));
  const results: ModelBenchResult[] = [];
  for (const model of options.models) {
    const result = emptyResult(model, cases);
    let totalMs = 0;
    for (const bench of cases) {
      for (let attempt = 1; attempt <= tries; attempt += 1) {
        const started = now();
        let outcome: TryOutcome;
        try {
          const reply = await options.complete(model, {
            prompt: `${BENCH_SYSTEM_HINT}\n\n${bench.prompt}`,
            tools: BENCH_TOOLS,
          });
          outcome = scoreToolCall(bench, reply).outcome;
        } catch (err) {
          outcome = "error";
          result.firstError ??= err instanceof Error ? err.message : String(err);
        }
        totalMs += now() - started;
        count(result, bench.id, outcome);
        options.onTry?.({ model, caseId: bench.id, attempt, outcome });
      }
    }
    result.avgMs = result.tries > 0 ? Math.round(totalMs / result.tries) : 0;
    results.push(result);
  }
  return results;
}
