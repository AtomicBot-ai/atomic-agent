import {
  buildStatusSnapshot,
  describeResult,
  formatStatusSnapshot,
  type PlanProgressLike,
  type TurnStatusState,
} from "../agent/status-snapshot.js";
import type { TuiState } from "./tui-state.js";

/**
 * The TUI's `/status` (ATO-965): the same snapshot Telegram and the
 * desktop print, built from what the TUI already keeps for the visible
 * session: the run's start, the step counter, the call in flight, the
 * last finished tool card and the approval prompt, if one is up.
 *
 * `plan` is the live plan's progress (`planProgress(...)`, ATO-486) once
 * the TUI keeps one; until then the plan part is simply left out.
 */
export function tuiTurnStatus(
  state: Pick<
    TuiState,
    | "status"
    | "runStartedAt"
    | "currentStep"
    | "streamingToolCalls"
    | "streamingToolCards"
    | "pendingApproval"
    | "runHistory"
  >,
  plan: PlanProgressLike | null = null,
): TurnStatusState {
  const running =
    state.status === "running" || state.status === "awaiting_approval";
  if (!running) {
    const last = state.runHistory[state.runHistory.length - 1];
    if (!last) return { running: false, startedAt: null, steps: 0 };
    return {
      running: false,
      startedAt: last.finishedAt - last.durationMs,
      endedAt: last.finishedAt,
      steps: last.stepCount,
    };
  }
  const inFlight = state.streamingToolCalls[state.streamingToolCalls.length - 1];
  const finished = [...state.streamingToolCards]
    .reverse()
    .find((card) => card.status !== "pending" && card.tool !== "reply" && card.tool !== "finish");
  return {
    running: true,
    startedAt: state.runStartedAt,
    steps: state.currentStep + 1,
    plan,
    current: inFlight ? `Running ${inFlight.tool}` : null,
    lastResult: finished
      ? describeResult({
          tool: finished.tool,
          status: finished.status === "ok" ? "ok" : "error",
          summary: finished.summary,
          details: finished.details ?? {},
          truncated: finished.truncated,
        })
      : null,
    blockedOn: state.pendingApproval?.tool ?? null,
  };
}

/** The text `/status` prints into the chat log. */
export function formatTuiStatus(
  state: Parameters<typeof tuiTurnStatus>[0],
  now: number,
  plan: PlanProgressLike | null = null,
): string {
  return formatStatusSnapshot(
    buildStatusSnapshot(tuiTurnStatus(state, plan), now),
    "tui",
  );
}
