/**
 * The day's spend ceiling refused a paid link before anything was sent
 * (ATO-649, `llm.costTracking.dailyLimitUsd`).
 *
 * Thrown from the fallback seam's per-attempt hook. What the chain does
 * with it follows `llm.costTracking.onDailyLimit`, carried on the error
 * as `onLimit`:
 *  - `"stop"` (default): `shouldAdvance` does not move on, so no other
 *    link is tried, the turn ends on this sentence, and every later
 *    paid call that day is refused the same way.
 *  - `"local"`: `shouldAdvance` moves on to the next link (the local
 *    model, when the chain has one) and the chain's switch notice says
 *    why in the chat.
 * Either way, when nothing else can serve, the turn ends on this sentence
 * instead of waiting out an outage. A leaf module on purpose: the
 * classifier, the chain and the turn recovery all read it, and none of
 * them may import the others.
 */
export type DailySpendLimitAction = "stop" | "local";

export class DailySpendLimitError extends Error {
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly providerId: string;
  readonly onLimit: DailySpendLimitAction;

  constructor(params: {
    spentUsd: number;
    limitUsd: number;
    providerId: string;
    onLimit?: DailySpendLimitAction;
  }) {
    const onLimit = params.onLimit ?? "stop";
    super(dailySpendLimitSentence(params.spentUsd, params.limitUsd, onLimit));
    this.name = "DailySpendLimitError";
    this.spentUsd = params.spentUsd;
    this.limitUsd = params.limitUsd;
    this.providerId = params.providerId;
    this.onLimit = onLimit;
  }
}

/**
 * The chat sentence. With `"local"` it is also the reason on the switch
 * notice, so it names no next step: the notice says where answers come
 * from, and when no link could answer the failed attempts say why.
 */
export function dailySpendLimitSentence(
  spentUsd: number,
  limitUsd: number,
  onLimit: DailySpendLimitAction,
): string {
  const head = `Daily cloud limit reached: ${usd(spentUsd)} of ${usd(limitUsd)}. Cloud calls are paused until tomorrow.`;
  return onLimit === "local"
    ? head
    : `${head} Raise llm.costTracking.dailyLimitUsd or set llm.costTracking.onDailyLimit to "local" to use your local model.`;
}

/** The spend-limit refusal in `err` or one of its causes, if any. */
export function findDailySpendLimitError(err: unknown): DailySpendLimitError | null {
  let current: unknown = err;
  for (let depth = 0; depth < 6; depth += 1) {
    if (current instanceof DailySpendLimitError) return current;
    if (typeof current !== "object" || current === null) return null;
    const next = (current as { cause?: unknown }).cause;
    if (next === current) return null;
    current = next;
  }
  return null;
}

/** The error, or one of its causes, is a spend-limit refusal. */
export function isDailySpendLimitError(err: unknown): boolean {
  return findDailySpendLimitError(err) !== null;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}
