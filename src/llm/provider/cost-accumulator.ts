import type { CompletionUsage } from "./completion-types.js";
import type { ResolvedModel } from "./model-resolver.js";

export type CostAccumulatorSnapshot = {
  sessionUsd: number;
  dayUsd: number;
  lastTurnUsd: number;
  lastModelId: string | null;
};

/**
 * Rolls up estimated spend from completion usage + per-model pricing.
 * Pricing comes from userModels / catalog via `ResolvedModel`.
 */
export class CostAccumulator {
  private sessionUsd = 0;
  private dayUsd = 0;
  private lastTurnUsd = 0;
  private lastModelId: string | null = null;
  private dayKey: string;

  constructor(private readonly dailyResetHourUtc = 0) {
    this.dayKey = utcDayKey(new Date(), dailyResetHourUtc);
  }

  recordTurn(params: {
    modelId: string | null;
    usage?: CompletionUsage;
    model?: ResolvedModel;
  }): void {
    this.rotateDayIfNeeded();
    const cost = estimateCost(params.usage, params.model);
    this.lastTurnUsd = cost;
    this.lastModelId = params.modelId;
    this.sessionUsd += cost;
    this.dayUsd += cost;
  }

  snapshot(): CostAccumulatorSnapshot {
    this.rotateDayIfNeeded();
    return {
      sessionUsd: this.sessionUsd,
      dayUsd: this.dayUsd,
      lastTurnUsd: this.lastTurnUsd,
      lastModelId: this.lastModelId,
    };
  }

  resetSession(): void {
    this.sessionUsd = 0;
    this.lastTurnUsd = 0;
    this.lastModelId = null;
  }

  private rotateDayIfNeeded(): void {
    const key = utcDayKey(new Date(), this.dailyResetHourUtc);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.dayUsd = 0;
    }
  }
}

function estimateCost(
  usage: CompletionUsage | undefined,
  model: ResolvedModel | undefined,
): number {
  if (!usage || !model?.pricing) return 0;
  const { input, output } = model.pricing;
  const prompt = usage.promptTokens / 1_000_000;
  const completion = usage.completionTokens / 1_000_000;
  return prompt * input + completion * output;
}

function utcDayKey(now: Date, resetHourUtc: number): string {
  const d = new Date(now);
  if (d.getUTCHours() < resetHourUtc) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}
