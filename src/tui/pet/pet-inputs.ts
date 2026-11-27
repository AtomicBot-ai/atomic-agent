import type { RunHistoryEntry, TuiState } from "../tui-state.js";
import { PetMachine, type PetEnding, type PetInputs, type PetStep } from "./pet-machine.js";

/**
 * ATO-2513: what the terminal pet reads from the TUI's own state. The
 * desktop pet reads the agent's turn frames for the same two facts; here
 * the reducer has already folded them into `TuiState`, so nothing new is
 * asked of the runtime and no model is called.
 *
 * - waiting: an approval request (or an `ask_user` question) is on screen;
 * - working: the open turn has a tool call in flight;
 * - thinking: a turn runs and no tool does;
 * - how a turn ended: the newest `runHistory` entry, which the reducer
 *   writes exactly once per finished turn.
 */
export type PetTuiView = Pick<
  TuiState,
  "status" | "pendingApproval" | "streamingToolCalls" | "streamingToolCards" | "runHistory"
>;

export function petInputsFromTui(state: PetTuiView): PetInputs {
  const waiting = state.pendingApproval !== null || state.status === "awaiting_approval";
  if (state.status !== "running" && state.status !== "awaiting_approval") {
    return { activity: null, waiting };
  }
  const toolRunning =
    state.streamingToolCalls.length > 0 ||
    state.streamingToolCards.some((card) => card.status === "pending");
  return { activity: toolRunning ? "working" : "thinking", waiting };
}

/** A finished run's outcome in the pet's words. */
export function petEndingOf(entry: Pick<RunHistoryEntry, "outcome">): PetEnding {
  if (entry.outcome === "failed") return "error";
  if (entry.outcome === "cancelled") return "stopped";
  return "done";
}

/**
 * The run that finished since `seenAt` (the `finishedAt` of the newest
 * entry already reported), or null. The first look passes the newest
 * entry's own stamp, so a run that ended before the pet came up is never
 * flashed.
 */
export function petNewEnding(
  history: readonly RunHistoryEntry[],
  seenAt: number | null,
): { ending: PetEnding; finishedAt: number } | null {
  const last = history[history.length - 1];
  if (!last) return null;
  if (seenAt !== null && last.finishedAt <= seenAt) return null;
  return { ending: petEndingOf(last), finishedAt: last.finishedAt };
}

/** The stamp to start from: the newest entry's, or null for an empty history. */
export function petHistoryMark(history: readonly RunHistoryEntry[]): number | null {
  const last = history[history.length - 1];
  return last ? last.finishedAt : null;
}

/**
 * The machine plus the run-history bookmark: one per chip. `update` is the
 * whole job of a render: report a turn that ended since the last look,
 * then step with what runs now.
 */
export class PetTuiDriver {
  private readonly machine: PetMachine;
  private seen: number | null | undefined = undefined;

  constructor(now: number) {
    this.machine = new PetMachine(now);
  }

  update(view: PetTuiView, now: number): PetStep {
    if (this.seen === undefined) {
      this.seen = petHistoryMark(view.runHistory);
    } else {
      const fresh = petNewEnding(view.runHistory, this.seen);
      if (fresh) {
        this.machine.ended(fresh.ending, now);
        this.seen = fresh.finishedAt;
      }
    }
    return this.machine.step(petInputsFromTui(view), now);
  }
}
