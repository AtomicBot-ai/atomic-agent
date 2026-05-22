/**
 * Memory-eval LLM-as-judge wrapper. Reuses the existing
 * `eval/harness/judge-client.ts` config + HTTP path so the rubric
 * format, scoring scale, and `.env` knobs are identical across the
 * two harnesses (the operator only has to learn one judge).
 *
 * The 1..5 scoring scale from `eval/` is fine for memory experiments:
 *
 *  - E3 maps `useful=5 / trivia=3 / wrong=1` via per-entry rubrics.
 *  - E4 grades activation / principle / coverage on the same 1..5
 *    axis, then averages.
 *  - E2 grades the agent's final reply on the same 1..5 axis.
 *
 * Centralising on one shape lets us cross-compare scores between
 * `eval/` and `eval-memory/` reports without unit conversion.
 */

import {
  createJudgeClient,
  loadJudgeConfigFromEnv,
} from "../../eval/harness/judge-client.js";
import type {
  JudgeClient,
  JudgeInput,
  JudgeVerdict,
  JudgeConfig,
} from "../../eval/harness/judge-types.js";

export type {
  JudgeClient,
  JudgeInput,
  JudgeVerdict,
  JudgeConfig,
} from "../../eval/harness/judge-types.js";

/**
 * Resolve the judge from env. Returns `null` when the judge is
 * disabled (no API key, `ATOMIC_AGENT_JUDGE_DISABLED=1`, etc.). The
 * caller decides whether to fail loudly or skip the experiment when
 * the judge is unavailable — different experiments have different
 * fallback behaviour.
 *
 *  - E1 never uses the judge.
 *  - E3 / E4 require it; bail with a clear error when null.
 *  - E2 falls back to "metrics only" (tool count, tokens) when the
 *    judge is missing.
 */
export function resolveJudge(): { client: JudgeClient; config: JudgeConfig } | null {
  const config = loadJudgeConfigFromEnv();
  if (!config) return null;
  return { client: createJudgeClient(config), config };
}

export interface ScoreOptions {
  /** Optional retries for transient HTTP failures. Defaults to 1. */
  retries?: number;
  /** Optional backoff between retries (ms). Defaults to 500. */
  backoffMs?: number;
}

/**
 * Wrapper around `client.score(input)` that adds a small retry loop
 * for transient errors. The judge is a single HTTP hop to OpenRouter
 * by default — a momentary 429 / 502 should not kill a 30-minute
 * experiment.
 */
export async function scoreWithRetry(
  client: JudgeClient,
  input: JudgeInput,
  opts: ScoreOptions = {},
): Promise<JudgeVerdict> {
  const retries = opts.retries ?? 1;
  const backoffMs = opts.backoffMs ?? 500;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await client.score(input);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
