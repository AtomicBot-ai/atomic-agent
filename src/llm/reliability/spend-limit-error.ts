/**
 * The day's spend ceiling refused a paid link before anything was sent
 * (ATO-649, `llm.costTracking.dailyLimitUsd`).
 *
 * Thrown from the fallback seam's per-attempt hook, so the chain treats
 * it like the link saying no: `shouldAdvance` moves on to the next link
 * (a local model, when the chain has one), and when nothing else can
 * serve, the turn ends on this sentence instead of waiting out an
 * outage. A leaf module on purpose: the classifier, the chain and the
 * turn recovery all read it, and none of them may import the others.
 */
export class DailySpendLimitError extends Error {
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly providerId: string;

  constructor(params: { spentUsd: number; limitUsd: number; providerId: string }) {
    super(
      `Today's spend limit is reached: ${usd(params.spentUsd)} of ${usd(params.limitUsd)} ` +
        `(llm.costTracking.dailyLimitUsd), so "${params.providerId}" was not called. ` +
        "Switch to a local model, or raise the limit.",
    );
    this.name = "DailySpendLimitError";
    this.spentUsd = params.spentUsd;
    this.limitUsd = params.limitUsd;
    this.providerId = params.providerId;
  }
}

/** The error, or one of its causes, is a spend-limit refusal. */
export function isDailySpendLimitError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 6; depth += 1) {
    if (current instanceof DailySpendLimitError) return true;
    if (typeof current !== "object" || current === null) return false;
    const next = (current as { cause?: unknown }).cause;
    if (next === current) return false;
    current = next;
  }
  return false;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}
