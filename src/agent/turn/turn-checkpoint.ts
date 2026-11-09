import type { SessionState } from "../../session/session-state.js";
import type { RunTurnOptions, StepCheckpoint } from "../agent-contract.js";

/**
 * Hand one completed step to the caller's checkpoint (ATO-1109), so the
 * turn's work so far is durable before the next step starts. The hook is
 * bookkeeping: a checkpoint that throws (a locked or full database) is
 * logged and the turn goes on, exactly as it would have without one.
 */
export function checkpointStep(
  options: Pick<RunTurnOptions, "onStepCheckpoint">,
  session: SessionState,
  step: StepCheckpoint,
  logger?: { warn(message: string, fields?: Record<string, unknown>): void },
): void {
  if (options.onStepCheckpoint === undefined) return;
  try {
    options.onStepCheckpoint(session, step);
  } catch (err) {
    logger?.warn("could not checkpoint a completed step", {
      sessionId: session.id,
      stepIndex: step.stepIndex,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
