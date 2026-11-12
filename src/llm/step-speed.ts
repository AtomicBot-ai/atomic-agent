import type { CompletionTiming } from "./provider/completion-types.js";

/**
 * Why one model step took as long as it did (ATO-631): how much of the
 * prompt had to be read again versus served from the KV cache, how long
 * that took, and how fast the reply was then written. A user waiting on
 * a slow reply can tell "re-reading 30k tokens" from "writing 12 tok/s".
 *
 * Built from the `timing` a completion already carries, so it costs no
 * extra request. Every field is what the provider reported; nothing is
 * invented for a provider that reports less (cloud APIs send no
 * millisecond split, so they get no rate).
 */
export interface StepSpeed {
  /** Decode speed, tokens per second; `null` when it cannot be known. */
  decodeTokensPerSecond: number | null;
  /** The whole prompt, evaluated plus reused. */
  promptTokens: number;
  /** The part of the prompt served from the KV cache. */
  cachedTokens: number;
  /** Prompt evaluation (prefill) time, ms; 0 when not reported. */
  prefillMs: number;
  /** Reply generation (decode) time, ms; 0 when not reported. */
  decodeMs: number;
  /** Speculative decoding: proposed and kept draft tokens. */
  draftTokens?: number;
  draftAcceptedTokens?: number;
}

/**
 * The speed reading of one completion, or `null` when the completion
 * says nothing useful (no prompt count, no decode rate).
 */
export function stepSpeedFromCompletion(completion: {
  timing?: CompletionTiming | null;
  cacheHitTokens?: number;
}): StepSpeed | null {
  const timing = completion.timing;
  if (!timing) return null;
  const promptTokens = nonNegative(timing.promptTokens);
  const cachedTokens = Math.min(
    promptTokens,
    nonNegative(completion.cacheHitTokens ?? 0),
  );
  const decodeTokensPerSecond = decodeRate(timing);
  if (promptTokens === 0 && decodeTokensPerSecond === null) return null;
  const draft = nonNegative(timing.draftTokens ?? 0);
  return {
    decodeTokensPerSecond,
    promptTokens,
    cachedTokens,
    prefillMs: nonNegative(timing.promptMs),
    decodeMs: nonNegative(timing.predictedMs),
    ...(draft > 0
      ? {
          draftTokens: draft,
          draftAcceptedTokens: Math.min(
            draft,
            nonNegative(timing.draftAcceptedTokens ?? 0),
          ),
        }
      : {}),
  };
}

/** Share of the prompt served from the cache, 0..1; `null` for an empty prompt. */
export function cacheHitShare(speed: StepSpeed): number | null {
  if (speed.promptTokens <= 0) return null;
  return speed.cachedTokens / speed.promptTokens;
}

/** Share of draft tokens the main model kept, 0..1; `null` without a draft model. */
export function draftAcceptanceShare(speed: StepSpeed): number | null {
  if (!speed.draftTokens || speed.draftTokens <= 0) return null;
  return (speed.draftAcceptedTokens ?? 0) / speed.draftTokens;
}

/**
 * Prefill shorter than this is not worth a word in the status line: the
 * reader is asking "why is this slow", and a sub-two-second read is not
 * the answer.
 */
export const PREFILL_SHOWN_FROM_MS = 2_000;

/**
 * The status-line parts, in reading order: speed, cache share, prefill
 * when it was long, draft acceptance when a draft model ran. Empty when
 * there is nothing to say. Every glyph is single-width.
 *
 * `12 tok/s`, `cache 92%`, `read 30k in 41s`, `draft 71%`.
 */
export function formatStepSpeedParts(speed: StepSpeed | null): string[] {
  if (!speed) return [];
  const parts: string[] = [];
  if (speed.decodeTokensPerSecond !== null) {
    parts.push(`${formatRate(speed.decodeTokensPerSecond)} tok/s`);
  }
  const share = cacheHitShare(speed);
  if (share !== null) parts.push(`cache ${Math.round(share * 100)}%`);
  if (speed.prefillMs >= PREFILL_SHOWN_FROM_MS) {
    const read = speed.promptTokens - speed.cachedTokens;
    parts.push(
      `read ${formatTokens(read)} in ${formatSeconds(speed.prefillMs)}`,
    );
  }
  const draft = draftAcceptanceShare(speed);
  if (draft !== null) parts.push(`draft ${Math.round(draft * 100)}%`);
  return parts;
}

function decodeRate(timing: CompletionTiming): number | null {
  const stated = timing.predictedPerSecond;
  if (typeof stated === "number" && Number.isFinite(stated) && stated > 0) {
    return stated;
  }
  const n = nonNegative(timing.predictedTokens);
  const ms = nonNegative(timing.predictedMs);
  if (n > 0 && ms > 0) return (n / ms) * 1000;
  return null;
}

function formatRate(perSecond: number): string {
  return perSecond < 10 ? perSecond.toFixed(1) : String(Math.round(perSecond));
}

function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
}

function formatSeconds(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const total = Math.round(s);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}
