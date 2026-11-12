import { getConfig } from "../../config/index.js";
import type { RunTurnResult } from "../../agent/agent-contract.js";
import type { LlmStreamParams } from "../../agent/step/step-contract.js";
import {
  GOAL_CHECK_TIMEOUT_MS,
  buildGoalJudgePrompt,
  buildGoalContinuationMessage,
  buildGoalJudgeRequest,
  buildGoalKickoffMessage,
  createGoalState,
  extractGoalJudgeText,
  normalizeGoalSpec,
  readGoalState,
  resumeGoalState,
  runGoal,
  sameGoalSpec,
  withGoalState,
  type GoalCheckResult,
  type GoalSpec,
  type GoalState,
} from "../../agent/goal/index.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { ToolCallTransport } from "../../llm/provider/completion-types.js";
import type { SlotManager } from "../../llm/slot-manager.js";
import type { SessionStore } from "../../session/session-store.js";
import type { SessionState } from "../../session/index.js";
import { spawnVerifyProcess } from "../../tools/verify/spawn-verify-process.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

/**
 * Goal mode's runtime side (ATO-451): the real dependencies of the goal
 * controller. Rounds are ordinary `runTurn` calls, so every round goes
 * through the per-session queue, approvals and persistence like any
 * other turn; checks run in the session's folder through the verify
 * process spawner (timeout, process-group kill); the judge is one
 * side-call on the active model (same posture as the session namer).
 */
export interface RuntimeGoalDeps {
  sessionStore: Pick<SessionStore, "load" | "save">;
  llmComplete: (params: LlmStreamParams) => Promise<CompletionResult>;
  slotManager: Pick<SlotManager, "sideCallSlotId">;
  resolveTransport: () => ToolCallTransport;
  logger: StructuredLogger;
}

export interface RuntimeGoalRunOptions {
  goal: GoalSpec;
  signal?: AbortSignal;
  taskMaxDurationMs?: number;
  taskMaxCostUsd?: number;
  onGoalProgress?: (goal: GoalState) => void;
}

/** One ordinary turn with an optional duration ceiling (no goal). */
export type GoalRoundRunner = (
  session: SessionState,
  message: string,
  taskMaxDurationMs: number | undefined,
  taskMaxCostUsd?: number,
) => Promise<RunTurnResult>;

export function createRuntimeGoalRunner(deps: RuntimeGoalDeps) {
  const { sessionStore, llmComplete, slotManager, resolveTransport, logger } = deps;
  const running = new Set<string>();
  const controls = new Map<string, "pause" | "clear">();

  /**
   * Ask a running goal to stop after its current round. `false` when no
   * goal runs on that session; the caller then edits the stored goal.
   */
  const control = (sessionId: string, verb: "pause" | "clear"): boolean => {
    if (!running.has(sessionId)) return false;
    controls.set(sessionId, verb);
    return true;
  };

  const saveGoal = (sessionId: string, state: GoalState | null): void => {
    // Not stored yet (a fresh chat before its first turn): the round's own
    // save carries the goal, which rides on the session it was handed.
    const current = sessionStore.load(sessionId);
    if (current === null) return;
    sessionStore.save({ ...current, metadata: withGoalState(current.metadata, state) });
  };

  const runChecks = async (
    commands: readonly string[],
    context: { workingDir: string; signal: AbortSignal },
  ): Promise<GoalCheckResult[]> => {
    const results: GoalCheckResult[] = [];
    for (const command of commands) {
      if (context.signal.aborted) break;
      // A command line with spaces or shell syntax goes through `sh -c`
      // (`cmd.exe /c`), the same rule `verify.run` and `os.shell.run` use.
      const proc = spawnVerifyProcess(command, [], {
        cwd: context.workingDir,
        network: true,
        timeoutMs: GOAL_CHECK_TIMEOUT_MS,
        signal: context.signal,
      });
      const exit = await proc.exited;
      const output = [proc.stdout.tail(), proc.stderr.tail(), exit.spawnError ?? ""]
        .filter((part) => part.trim().length > 0)
        .join("\n");
      results.push({
        command,
        passed: exit.exitCode === 0 && !exit.timedOut && !exit.aborted && exit.spawnError === undefined,
        exitCode: exit.exitCode,
        timedOut: exit.timedOut,
        output,
      });
    }
    return results;
  };

  const judge = async (
    input: Parameters<typeof buildGoalJudgePrompt>[0],
    context: { sessionId: string; signal: AbortSignal },
  ): Promise<string> => {
    const request = buildGoalJudgeRequest({
      prompt: buildGoalJudgePrompt(input),
      sessionId: context.sessionId,
      transport: resolveTransport(),
      slotId: slotManager.sideCallSlotId(),
      serverTemplate: getConfig().localModels.useServerTemplate !== "off",
    });
    const result = await llmComplete({ ...request, signal: context.signal });
    return extractGoalJudgeText(result);
  };

  /**
   * Run turns as goal rounds. A stored goal with the same acceptance list
   * is resumed (rounds and marks kept; a used-up round budget and the
   * judge's failure count start over, since the person chose to go on);
   * a different list starts a new goal.
   */
  const run = async (
    session: SessionState,
    userMessage: string,
    options: RuntimeGoalRunOptions,
    runRound: GoalRoundRunner,
  ): Promise<RunTurnResult> => {
    if (running.has(session.id)) {
      throw new Error("a goal is already running in this session");
    }
    const stored = readGoalState((sessionStore.load(session.id) ?? session).metadata);
    const resumed = stored !== null && sameGoalSpec(stored, options.goal) && stored.status !== "complete";
    // The caller's limits win on resume: the spec is what it asked for now.
    const limits = normalizeGoalSpec(options.goal);
    const goal: GoalState = resumed
      ? resumeGoalState({ ...stored, maxRounds: limits.maxRounds, maxTokens: limits.maxTokens }, Date.now())
      : createGoalState(options.goal, Date.now());
    const message = userMessage.trim().length > 0
      ? userMessage
      : resumed && stored.roundsUsed > 0
        ? buildGoalContinuationMessage(goal, [])
        : buildGoalKickoffMessage(goal);
    running.add(session.id);
    controls.delete(session.id);
    try {
      const outcome = await runGoal(
        {
          runRound: (s, m, o) => runRound(s, m, o.taskMaxDurationMs, o.taskMaxCostUsd),
          runChecks,
          judge,
          saveGoal,
          pendingControl: (id) => {
            const verb = controls.get(id) ?? null;
            controls.delete(id);
            return verb;
          },
          ...(options.onGoalProgress ? { onProgress: options.onGoalProgress } : {}),
        },
        {
          session: { ...session, metadata: withGoalState(session.metadata, goal) },
          message,
          goal,
          signal: options.signal ?? new AbortController().signal,
          // All rounds together stay inside the turn's own time ceiling.
          taskMaxDurationMs: options.taskMaxDurationMs ?? getConfig().agent.task.maxDurationMs,
          // And inside its money budget (ATO-1288): one cap for all rounds.
          taskMaxCostUsd: options.taskMaxCostUsd ?? getConfig().agent.task.maxCostUsd,
        },
      );
      if (outcome.goal === null) saveGoal(session.id, null);
      logger.info("goal run ended", {
        sessionId: session.id,
        status: outcome.goal?.status ?? "cleared",
        rounds: outcome.goal?.roundsUsed ?? 0,
      });
      return outcome.result;
    } finally {
      running.delete(session.id);
      controls.delete(session.id);
    }
  };

  return { run, control };
}
