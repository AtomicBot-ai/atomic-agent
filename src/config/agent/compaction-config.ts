import { ConfigValidationError } from "../config-validation-error.js";
import { parseBool, parsePositiveInt, parseHalfOpenUnitInterval } from "../config-primitives.js";

/**
 * How a checkpoint summary is made. `model` asks the active model;
 * `extractive` builds it from the records without inference; `auto`
 * chooses per attempt (see `chooseCompactionMethod` in the runtime).
 */
export type CompactionMode = "auto" | "model" | "extractive";
export const COMPACTION_MODES: readonly CompactionMode[] = ["auto", "model", "extractive"];

export interface CompactionConfig {
  auto: boolean;
  mode: CompactionMode;
  triggerRatio: number;
  targetRatio: number;
  summaryMaxTokens: number;
  /** Timeout of one summary call; the total budget scales with chunk count. */
  timeoutMs: number;
  maxTotalTimeoutMs: number;
  /**
   * Under `auto`, extend a rolling summary between turns so compaction can
   * swap it in without a model call. Optional: absent means on. It still
   * runs only where it is safe and worthwhile (see the runtime's
   * background scheduler); `false` turns it off everywhere.
   */
  background?: boolean;
}

export function createCompactionDefaults(): CompactionConfig {
  return { auto: true, mode: "auto", triggerRatio: 0.9, targetRatio: 0.65, summaryMaxTokens: 2048,
    timeoutMs: 600_000, maxTotalTimeoutMs: 600_000, background: true };
}

function parseCompactionMode(raw: unknown): CompactionMode {
  if (typeof raw === "string" && (COMPACTION_MODES as readonly string[]).includes(raw)) return raw as CompactionMode;
  throw new ConfigValidationError("agent.compaction.mode", `expected one of ${COMPACTION_MODES.join(", ")}`);
}

export function parseCompactionConfig(raw: unknown, defaults: CompactionConfig): CompactionConfig {
  if (raw == null) return { ...defaults };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError("agent.compaction", "expected an object");
  }
  const input = raw as Record<string, unknown>;
  const result = {
    auto: parseBool(input.auto ?? defaults.auto, "agent.compaction.auto"),
    mode: parseCompactionMode(input.mode ?? defaults.mode),
    triggerRatio: parseHalfOpenUnitInterval(input.triggerRatio ?? defaults.triggerRatio, "agent.compaction.triggerRatio"),
    targetRatio: parseHalfOpenUnitInterval(input.targetRatio ?? defaults.targetRatio, "agent.compaction.targetRatio"),
    summaryMaxTokens: parsePositiveInt(input.summaryMaxTokens ?? defaults.summaryMaxTokens, "agent.compaction.summaryMaxTokens"),
    timeoutMs: parsePositiveInt(input.timeoutMs ?? defaults.timeoutMs, "agent.compaction.timeoutMs"),
    maxTotalTimeoutMs: parsePositiveInt(input.maxTotalTimeoutMs ?? defaults.maxTotalTimeoutMs, "agent.compaction.maxTotalTimeoutMs"),
    background: parseBool(input.background ?? defaults.background ?? true, "agent.compaction.background"),
  };
  if (result.targetRatio >= result.triggerRatio || result.triggerRatio >= 1) {
    throw new ConfigValidationError("agent.compaction", "expected 0 < targetRatio < triggerRatio < 1");
  }
  return result;
}
