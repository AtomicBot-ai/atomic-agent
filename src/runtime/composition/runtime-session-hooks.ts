import type { RunTurnResult } from "../../agent/agent-contract.js";
import {
  HookBlockedPromptError,
  MAX_STOP_HOOK_CONTINUATIONS,
  stopHookMessage,
  type SessionHookEngine,
} from "../../hooks/session-hook-engine.js";
import { previousReplyText } from "../../prompt/request-section.js";
import type { SessionState } from "../../session/index.js";

/**
 * SessionStart and UserPromptSubmit for a turn about to run: what the hooks
 * added for the model. `session` (SessionStart) is the same on every turn
 * of the session; `turn` (UserPromptSubmit) is this turn's only. A
 * UserPromptSubmit block throws
 * `HookBlockedPromptError` before anything about the turn is written, so
 * the refused message is not saved (as in Claude Code).
 */
export async function startTurnHooks(
  engine: Pick<SessionHookEngine, "beforeTurn"> | null,
  session: SessionState,
  userMessage: string,
  signal: AbortSignal | undefined,
): Promise<TurnHookContext> {
  if (!engine) return {};
  const outcome = await engine.beforeTurn({
    sessionId: session.id,
    cwd: session.workingDir,
    prompt: userMessage,
    isNewSession: session.turns.length === 0,
    ...(signal ? { signal } : {}),
  });
  if (outcome.kind === "blocked") throw new HookBlockedPromptError(outcome.reason);
  return {
    ...(outcome.sessionContext !== undefined ? { session: outcome.sessionContext } : {}),
    ...(outcome.context !== undefined ? { turn: outcome.context } : {}),
  };
}

/** The hook text a turn's prompt carries (`RunTurnOptions.sessionHookContext` / `hookContext`). */
export interface TurnHookContext {
  session?: string;
  turn?: string;
}

/**
 * Stop hooks after a turn the model ended itself (reply or finish). After
 * a reply, a block sends the agent back to work with the hook's reason as
 * the next message, at most `MAX_STOP_HOOK_CONTINUATIONS` times, so a hook
 * that always blocks cannot keep a turn alive forever. After `finish` the
 * session is over and a block is ignored. No Stop hook runs after a cancel,
 * a failure or a ceiling stop (`stopCause`).
 */
export async function continueOnStopHooks(
  engine: Pick<SessionHookEngine, "afterTurn"> | null,
  first: RunTurnResult,
  signal: AbortSignal | undefined,
  again: (state: SessionState, message: string) => Promise<RunTurnResult>,
): Promise<RunTurnResult> {
  if (!engine) return first;
  let result = first;
  let steps = first.stepCount;
  let spend = first.spendUsd;
  const undelivered: string[] = [...(first.undelivered ?? [])];
  for (let round = 0; ; round++) {
    if (result.reason !== "reply" && result.reason !== "finish") break;
    if (result.stopCause !== undefined || signal?.aborted) break;
    const lastReply = previousReplyText(result.session.turns);
    const reason = await engine.afterTurn({
      sessionId: result.session.id,
      cwd: result.session.workingDir,
      ...(lastReply !== undefined ? { lastReply } : {}),
      stopHookActive: round > 0,
      ...(signal ? { signal } : {}),
    });
    if (reason === undefined || result.reason !== "reply") break;
    if (round >= MAX_STOP_HOOK_CONTINUATIONS || signal?.aborted) break;
    result = await again(result.session, stopHookMessage(reason));
    steps += result.stepCount;
    if (result.spendUsd !== undefined) spend = (spend ?? 0) + result.spendUsd;
    undelivered.push(...(result.undelivered ?? []));
  }
  if (result === first) return first;
  return {
    ...result,
    stepCount: steps,
    ...(spend !== undefined ? { spendUsd: spend } : {}),
    ...(undelivered.length > 0 ? { undelivered } : {}),
  };
}
