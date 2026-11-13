import { ConfigValidationError } from "./config-validation-error.js";
import { coerceFloatLike, parseBool, parseNonNegativeInt, parsePositiveInt } from "./config-primitives.js";

/**
 * What to do when the model provider stops answering.
 *
 * A dead endpoint used to end the turn after three fast retries
 * (~1s), so an outage of minutes turned every message the operator
 * sent into a one-second failure and the work in flight was
 * abandoned. Waiting is the honest response: the turn is parked,
 * the same step is retried on a backoff, and the run continues the
 * moment the provider answers.
 */
export interface ProviderWaitConfig {
  /** `false` restores the old behaviour: fail the turn immediately. */
  enabled: boolean;
  /** Give up (and fail the turn) after waiting this long in one outage. */
  maxWaitMs: number;
}

/**
 * Ceilings for one task. These, not `maxSteps`, are what actually
 * end a run that is still making progress.
 */
export interface AgentTaskConfig {
  /**
   * Hard ceiling on steps for one task. Reached, the loop spends its
   * last step summarising instead of being cut off mid-edit.
   */
  maxSteps: number;
  /** Wall-clock ceiling for one task. Same graceful ending. */
  maxDurationMs: number;
  /**
   * Carry on past a leg boundary while the work is progressing.
   * Off means the historical behaviour: stop at `agent.maxSteps`.
   */
  autoContinue: boolean;
  /**
   * Continue a durable task whose run a crash, a kill or a restart cut
   * off, from its session's per-step checkpoint, with a note telling the
   * model how far it got (ATO-1109). Off: the run starts over from the
   * task's message, as before. A run a person stopped is never resumed.
   */
  resumeInterrupted: boolean;
  /**
   * Resumes after the agent died under a task (crash or kill) before the
   * task is failed instead: the guard against a task that takes the
   * agent down every time. `0` fails it at the first such interruption.
   */
  maxResumes: number;
  /**
   * Spend ceiling for one task, in USD, estimated from each completion's
   * usage and the model's prices (prompt-cache aware). Reached, the task
   * ends the same graceful way as the time ceiling. `0` means no cap.
   * Unpriced models (a local model) count as $0, so this never stops
   * local work. Default `0`. Additive and unversioned: an older file has
   * no field and runs uncapped, as before.
   */
  maxCostUsd: number;
}

/**
 * Goal mode settings (`agent.goal`, ATO-1036). Separate from
 * `agent.task`: a task's ceilings end one run, these bound a goal across
 * all its rounds and restarts.
 */
export interface AgentGoalConfig {
  /**
   * Token budget a new goal starts with: prompt plus completion tokens
   * of all its rounds, as the provider reports them. `0` means no cap
   * (rounds, time and money still bound a goal). `/goal tokens` changes
   * it for one goal. Default `0`.
   */
  maxTokens: number;
}

export function createAgentGoalDefaults(): AgentGoalConfig {
  return { maxTokens: 0 };
}

/** Parse `agent.goal`. Absent block means the defaults. */
export function parseAgentGoal(
  raw: unknown,
  defaults: AgentGoalConfig,
): AgentGoalConfig {
  if (raw === undefined || raw === null) return defaults;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(
      "agent.goal",
      `expected object, got ${JSON.stringify(raw)}`,
    );
  }
  const goal = raw as Record<string, unknown>;
  return {
    maxTokens: parseNonNegativeInt(
      goal.maxTokens ?? defaults.maxTokens,
      "agent.goal.maxTokens",
    ),
  };
}

export function createProviderWaitDefaults(): ProviderWaitConfig {
  return {
    enabled: true,
    // Five minutes covers the outages people actually hit — a laptop
    // waking, a VPN reconnecting, a provider's gateway restarting —
    // without leaving a turn parked all afternoon. The task's own
    // wall-clock ceiling still applies on top.
    maxWaitMs: 300_000,
  };
}

export function createAgentTaskDefaults(): AgentTaskConfig {
  return {
    // ~40 legs of 25. Large enough for the multi-hour browser jobs
    // people actually ask for, small enough that a runaway is bounded
    // and visible: every leg boundary reports steps, elapsed time and
    // the ceiling it is counting towards.
    maxSteps: 1000,
    maxDurationMs: 7_200_000,
    autoContinue: true,
    resumeInterrupted: true,
    maxResumes: 3,
    maxCostUsd: 0,
  };
}

export function parseProviderWait(
  raw: unknown,
  defaults: ProviderWaitConfig,
): ProviderWaitConfig {
  if (raw === undefined || raw === null) return defaults;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(
      "agent.providerWait",
      `expected object, got ${JSON.stringify(raw)}`,
    );
  }
  const wait = raw as Record<string, unknown>;
  return {
    enabled: parseBool(
      wait.enabled ?? defaults.enabled,
      "agent.providerWait.enabled",
    ),
    maxWaitMs: parsePositiveInt(
      wait.maxWaitMs ?? defaults.maxWaitMs,
      "agent.providerWait.maxWaitMs",
    ),
  };
}

/**
 * Parse `agent.task` — the ceilings that end a task that is still
 * making progress. Absent block means the defaults, so an older config
 * file simply gains the behaviour.
 */
export function parseAgentTask(
  raw: unknown,
  defaults: AgentTaskConfig,
): AgentTaskConfig {
  if (raw === undefined || raw === null) return defaults;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(
      "agent.task",
      `expected object, got ${JSON.stringify(raw)}`,
    );
  }
  const task = raw as Record<string, unknown>;
  return {
    maxSteps: parsePositiveInt(
      task.maxSteps ?? defaults.maxSteps,
      "agent.task.maxSteps",
    ),
    maxDurationMs: parsePositiveInt(
      task.maxDurationMs ?? defaults.maxDurationMs,
      "agent.task.maxDurationMs",
    ),
    autoContinue: parseBool(
      task.autoContinue ?? defaults.autoContinue,
      "agent.task.autoContinue",
    ),
    resumeInterrupted: parseBool(
      task.resumeInterrupted ?? defaults.resumeInterrupted,
      "agent.task.resumeInterrupted",
    ),
    maxResumes: parseNonNegativeInt(
      task.maxResumes ?? defaults.maxResumes,
      "agent.task.maxResumes",
    ),
    maxCostUsd: parseNonNegativeUsd(
      task.maxCostUsd ?? defaults.maxCostUsd,
      "agent.task.maxCostUsd",
    ),
  };
}

/** A dollar amount: any finite number `>= 0`, fractions allowed. */
function parseNonNegativeUsd(raw: unknown, field: string): number {
  const value = coerceFloatLike(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new ConfigValidationError(
      field,
      `expected non-negative number, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}
