import { ConfigValidationError } from "../config-validation-error.js";
import { parseBool, parsePositiveInt, parseHalfOpenUnitInterval } from "../config-primitives.js";

export interface CompactionConfig {
  auto: boolean;
  triggerRatio: number;
  targetRatio: number;
  summaryMaxTokens: number;
  /** Timeout of one summary call; the total budget scales with chunk count. */
  timeoutMs: number;
  maxTotalTimeoutMs: number;
}

export function createCompactionDefaults(): CompactionConfig {
  return { auto: true, triggerRatio: 0.9, targetRatio: 0.65, summaryMaxTokens: 2048,
    timeoutMs: 600_000, maxTotalTimeoutMs: 600_000 };
}

export function parseCompactionConfig(raw: unknown, defaults: CompactionConfig): CompactionConfig {
  if (raw == null) return { ...defaults };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError("agent.compaction", "expected an object");
  }
  const input = raw as Record<string, unknown>;
  const result = {
    auto: parseBool(input.auto ?? defaults.auto, "agent.compaction.auto"),
    triggerRatio: parseHalfOpenUnitInterval(input.triggerRatio ?? defaults.triggerRatio, "agent.compaction.triggerRatio"),
    targetRatio: parseHalfOpenUnitInterval(input.targetRatio ?? defaults.targetRatio, "agent.compaction.targetRatio"),
    summaryMaxTokens: parsePositiveInt(input.summaryMaxTokens ?? defaults.summaryMaxTokens, "agent.compaction.summaryMaxTokens"),
    timeoutMs: parsePositiveInt(input.timeoutMs ?? defaults.timeoutMs, "agent.compaction.timeoutMs"),
    maxTotalTimeoutMs: parsePositiveInt(input.maxTotalTimeoutMs ?? defaults.maxTotalTimeoutMs, "agent.compaction.maxTotalTimeoutMs"),
  };
  if (result.targetRatio >= result.triggerRatio || result.triggerRatio >= 1) {
    throw new ConfigValidationError("agent.compaction", "expected 0 < targetRatio < triggerRatio < 1");
  }
  return result;
}
