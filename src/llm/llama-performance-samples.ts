/**
 * Per-request timings of the local model server, kept for the
 * performance view (`GET /api/local-model/performance`, issue #996).
 *
 * One sample per completed llama-server completion: the speeds and
 * token counts llama.cpp reports in the final event's `timings`, plus
 * what only the client can see — how long the person waited for the
 * first token and how many requests shared the server meanwhile. No
 * prompt or reply text is ever kept.
 */

/** How many samples a client keeps, newest last. */
export const PERFORMANCE_CAPACITY = 300;

export interface PerformanceSample {
  /** `Date.now()` when the completion finished. */
  at: number;
  /** The model file's name, without its directory; `null` when not reported. */
  modelId: string | null;
  streamed: boolean;
  /** Prompt tokens the server evaluated this time (`prompt_n`). */
  promptTokens: number | null;
  /** Prompt tokens reused from the KV cache (`cache_n`). */
  cacheTokens: number;
  promptMs: number | null;
  /** `null` for a prompt served entirely from the cache. */
  promptPerSecond: number | null;
  predictedTokens: number;
  predictedMs: number | null;
  generationPerSecond: number | null;
  /** Wait from the call to its first content or reasoning delta; streaming only. */
  ttftMs: number | null;
  /** `promptTokens + cacheTokens + predictedTokens`, `null` without `prompt_n`. */
  contextTokens: number | null;
  /** Most completion calls open on this client at once during this one (≥ 1). */
  concurrent: number;
}

/** `v` when it is a finite number, else `null`. Strings are not numbers here. */
export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * `num`, but a numeric string counts too. The client's throughput mean
 * (what Fusion sizes worker time limits from) has always read timings this
 * way, so it keeps doing so through `generationRate(t, lenientNum)`; the
 * performance samples read numbers only.
 */
export function lenientNum(v: unknown): number | null {
  if (typeof v === "string" && v.length > 0) {
    const parsed = Number.parseFloat(v);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return num(v);
}

/** A whole, non-negative count, or `null`. */
export function count(v: unknown): number | null {
  const n = num(v);
  return n !== null && n >= 0 ? Math.trunc(n) : null;
}

/**
 * Generation speed, tokens per second, from one completion's `timings`.
 * llama.cpp states it directly (`predicted_per_second`); an older server
 * without it still reports the count and the milliseconds it took.
 * `null` when neither gives a positive speed.
 */
export function generationRate(
  timings: Record<string, unknown>,
  read: (v: unknown) => number | null = num,
): number | null {
  const stated = read(timings.predicted_per_second);
  if (stated !== null && stated > 0) return stated;
  const n = read(timings.predicted_n);
  const ms = read(timings.predicted_ms);
  if (n !== null && ms !== null && n > 0 && ms > 0) return (n / ms) * 1000;
  return null;
}

/** The last segment of a path, so a local file path never leaves the process. */
function modelName(model: unknown): string | null {
  if (typeof model !== "string" || model.length === 0) return null;
  const segments = model.split(/[/\\]/);
  const last = segments[segments.length - 1] ?? "";
  return last.length > 0 ? last : null;
}

export interface SampleContext {
  streamed: boolean;
  ttftMs: number | null;
  concurrent: number;
  at: number;
}

/**
 * Map one llama-server completion payload (the unary response, or the
 * stream's final `stop: true` event) to a sample. `null` when the payload
 * carries no `timings` object.
 */
export function sampleFromPayload(
  payload: Record<string, unknown>,
  context: SampleContext,
): PerformanceSample | null {
  const timings = payload.timings;
  if (timings === null || typeof timings !== "object" || Array.isArray(timings)) {
    return null;
  }
  const t = timings as Record<string, unknown>;
  const promptTokens = count(t.prompt_n);
  const cacheTokens = count(t.cache_n) ?? 0;
  const promptMs = num(t.prompt_ms);
  const predictedTokens = count(t.predicted_n) ?? count(payload.tokens_predicted) ?? 0;
  return {
    at: context.at,
    modelId: modelName(payload.model),
    streamed: context.streamed,
    promptTokens,
    cacheTokens,
    promptMs,
    promptPerSecond: promptRate(t, promptTokens, promptMs),
    predictedTokens,
    predictedMs: num(t.predicted_ms),
    generationPerSecond: generationRate(t),
    ttftMs: context.ttftMs,
    // `tokens_cached` is deliberately not read: see `resolvePromptUsage`.
    contextTokens:
      promptTokens === null ? null : promptTokens + cacheTokens + predictedTokens,
    concurrent: context.concurrent,
  };
}

/**
 * Prompt speed. A prompt served wholly from the cache evaluated nothing,
 * so it has no speed, whatever `prompt_per_second` claims.
 */
function promptRate(
  t: Record<string, unknown>,
  promptTokens: number | null,
  promptMs: number | null,
): number | null {
  if (promptTokens === null || promptTokens === 0) return null;
  const stated = num(t.prompt_per_second);
  if (stated !== null && stated > 0) return stated;
  if (promptMs !== null && promptMs > 0) return (promptTokens / promptMs) * 1000;
  return null;
}

/** A bounded list of samples: the newest `capacity`, oldest first. */
export class PerformanceRing {
  private readonly items: PerformanceSample[] = [];

  constructor(readonly capacity: number = PERFORMANCE_CAPACITY) {}

  push(sample: PerformanceSample): void {
    this.items.push(sample);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  /** A copy, oldest first. */
  list(): PerformanceSample[] {
    return this.items.slice();
  }
}
