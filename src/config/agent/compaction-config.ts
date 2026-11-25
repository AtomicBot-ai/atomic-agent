import { ConfigValidationError } from "../config-validation-error.js";
import { isSetAsideString, parseBool, parseNonNegativeInt, parsePositiveInt, parseHalfOpenUnitInterval } from "../config-primitives.js";

/**
 * How a checkpoint summary is made. `model` asks the active model;
 * `extractive` builds it from the records without inference; `auto`
 * chooses per attempt (see `chooseCompactionMethod` in the runtime).
 */
export type CompactionMode = "auto" | "model" | "extractive";
export const COMPACTION_MODES: readonly CompactionMode[] = ["auto", "model", "extractive"];

export interface CompactionConfig {
  /**
   * Compact the conversation automatically once its history reaches
   * `triggerRatio` of the history allowance. `false` leaves only manual
   * and overflow compaction. Default `true`.
   */
  auto: boolean;
  /**
   * How a checkpoint summary is made: `model` asks the active model,
   * `extractive` builds it from the records without a model call, `auto`
   * (default) chooses per attempt.
   */
  mode: CompactionMode;
  /**
   * Share of the history allowance the conversation may fill before
   * automatic compaction runs. Default `0.9`; must be below 1 and above
   * `targetRatio`.
   */
  triggerRatio: number;
  /**
   * Share of the history allowance a compaction cuts the conversation
   * down to. Default `0.65`; must be below `triggerRatio`.
   */
  targetRatio: number;
  /**
   * Largest checkpoint summary a compaction asks for, in tokens. Default
   * `2048`; a small history allowance gets a smaller summary.
   */
  summaryMaxTokens: number;
  /**
   * Output tokens a summary call may spend on reasoning on top of
   * `summaryMaxTokens`. A thinking model writes its reasoning out of the
   * same reply allowance; without room for it the summary is cut off.
   * The summary itself is still held to `summaryMaxTokens`. Small windows
   * get less (see `compactionReplyBudget`); `0` sends no reserve.
   */
  reasoningReserveTokens: number;
  /** Timeout of one summary call; the total budget scales with chunk count. */
  timeoutMs: number;
  /**
   * Total time budget for one compaction's summary calls, in
   * milliseconds, however many chunks it takes. Default `600000`.
   */
  maxTotalTimeoutMs: number;
  /**
   * Under `auto`, extend a rolling summary between turns so compaction can
   * swap it in without a model call. Optional: absent means on. It still
   * runs only where it is safe and worthwhile (see the runtime's
   * background scheduler); `false` turns it off everywhere.
   */
  background?: boolean;
  /**
   * ATO-676. Before a compaction, ask the model for short dated
   * observations ("YYYY-MM-DD: ...") about the records being compacted
   * and store them as one memory note tagged `observations`. A private
   * side call: the visible chat is unchanged, and a failed flush never
   * stops the compaction. Optional: absent means off (the default).
   */
  memoryFlush?: boolean;
}

export function createCompactionDefaults(): CompactionConfig {
  return { auto: true, mode: "auto", triggerRatio: 0.9, targetRatio: 0.65, summaryMaxTokens: 2048,
    reasoningReserveTokens: 4096, timeoutMs: 600_000, maxTotalTimeoutMs: 600_000, background: true, memoryFlush: false };
}

function parseCompactionMode(raw: unknown, fallback: CompactionMode): CompactionMode {
  // ATO-1241: a mode a newer build added reads as the default here.
  if (isSetAsideString(raw, COMPACTION_MODES, "agent.compaction.mode", fallback)) return fallback;
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
    mode: parseCompactionMode(input.mode ?? defaults.mode, defaults.mode),
    triggerRatio: parseHalfOpenUnitInterval(input.triggerRatio ?? defaults.triggerRatio, "agent.compaction.triggerRatio"),
    targetRatio: parseHalfOpenUnitInterval(input.targetRatio ?? defaults.targetRatio, "agent.compaction.targetRatio"),
    summaryMaxTokens: parsePositiveInt(input.summaryMaxTokens ?? defaults.summaryMaxTokens, "agent.compaction.summaryMaxTokens"),
    reasoningReserveTokens: parseNonNegativeInt(input.reasoningReserveTokens ?? defaults.reasoningReserveTokens, "agent.compaction.reasoningReserveTokens"),
    timeoutMs: parsePositiveInt(input.timeoutMs ?? defaults.timeoutMs, "agent.compaction.timeoutMs"),
    maxTotalTimeoutMs: parsePositiveInt(input.maxTotalTimeoutMs ?? defaults.maxTotalTimeoutMs, "agent.compaction.maxTotalTimeoutMs"),
    background: parseBool(input.background ?? defaults.background ?? true, "agent.compaction.background"),
    memoryFlush: parseBool(input.memoryFlush ?? defaults.memoryFlush ?? false, "agent.compaction.memoryFlush"),
  };
  if (result.targetRatio >= result.triggerRatio || result.triggerRatio >= 1) {
    throw new ConfigValidationError("agent.compaction", "expected 0 < targetRatio < triggerRatio < 1");
  }
  return result;
}
