import { randomUUID } from "node:crypto";
import { LocalOutOfMemoryError } from "../../llm/index.js";
import type {
  AgentLoopDependencies,
  AgentLoopEvent,
  LocalOutOfMemoryChoice,
  RunTurnOptions,
} from "../agent-contract.js";
import type { TurnLoopState } from "./turn-state.js";

/**
 * Recovery from a managed local model that ran out of memory (ATO-334).
 *
 * Such a server keeps its socket and answers every request with a 500,
 * which used to read as an outage: the turn waited five minutes for a
 * server that would never answer differently. Now the turn restarts the
 * model with half the context window it ran with and retries the step.
 *
 * Who decides (Nadya, 2026-10-25): a person watching the chat is asked
 * first (`RunTurnOptions.localOutOfMemory: "ask"`); where nobody can
 * answer (a scheduled task, a Telegram or Discord chat, a headless run)
 * the window is halved without asking.
 *
 * The smaller window holds until the model is next started: the restart
 * does not write the config. Bounded twice: never below
 * `OUT_OF_MEMORY_MIN_CONTEXT_WINDOW`, and at most
 * `OUT_OF_MEMORY_MAX_RESTARTS` restarts with no step completed between
 * them. Past either, the turn ends with a sentence that says to pick a
 * smaller model: a model whose weights alone do not fit is not fixed by
 * a smaller window.
 */

/** The smallest window a restart goes down to: an agent turn needs room. */
export const OUT_OF_MEMORY_MIN_CONTEXT_WINDOW = 32_768;
/** Restarts in a row, with no step completed between them, before the turn stops. */
export const OUT_OF_MEMORY_MAX_RESTARTS = 3;
/** The answers offered to the person, the recommended one first. */
export const OUT_OF_MEMORY_CHOICES: readonly LocalOutOfMemoryChoice[] = [
  "restart_smaller",
  "pick_smaller_model",
  "cancel",
];

/**
 * Half of `current`, not below the floor; `null` when there is nothing
 * smaller left to try (already at or under the floor, or not known).
 */
export function halveContextWindow(current: number): number | null {
  if (!Number.isFinite(current) || current <= OUT_OF_MEMORY_MIN_CONTEXT_WINDOW) return null;
  return Math.max(OUT_OF_MEMORY_MIN_CONTEXT_WINDOW, Math.floor(current / 2));
}

/** The one chat note after a restart. */
export function formatOutOfMemoryRestarted(contextWindow: number): string {
  return `The model ran out of memory, restarted it with a context window of ${contextWindow} tokens.`;
}

export type OutOfMemoryOutcome =
  | { kind: "retry_same" }
  | { kind: "cancelled" }
  | { kind: "stop"; error: LocalOutOfMemoryError };

export interface OutOfMemoryRecoveryInput {
  sessionId: string;
  /** The window the failing run was started with; `0` when unknown. */
  contextWindow: number;
  /** The server error that revealed it, kept on the final error's `cause`. */
  cause: Error;
  options: Pick<RunTurnOptions, "signal" | "localOutOfMemory">;
}

export async function recoverFromOutOfMemory(
  input: OutOfMemoryRecoveryInput,
  deps: Pick<AgentLoopDependencies, "localOutOfMemory" | "onEvent" | "logger">,
  turn: Pick<TurnLoopState, "oomRestarts">,
): Promise<OutOfMemoryOutcome> {
  const { contextWindow, options } = input;
  const port = deps.localOutOfMemory;
  const next = halveContextWindow(contextWindow);
  const attempt = turn.oomRestarts + 1;
  const event = (
    phase: Extract<AgentLoopEvent, { type: "local_model_out_of_memory" }>["phase"],
    message: string,
    extra: { questionId?: string; options?: readonly LocalOutOfMemoryChoice[] } = {},
  ): void => {
    deps.onEvent?.({
      type: "local_model_out_of_memory",
      phase,
      contextWindow,
      nextContextWindow: next,
      attempt,
      maxAttempts: OUT_OF_MEMORY_MAX_RESTARTS,
      message,
      ...extra,
    });
  };
  const stop = (message: string): OutOfMemoryOutcome => {
    event("stopped", message);
    deps.logger?.warn("local model ran out of memory; ending the turn", {
      sessionId: input.sessionId,
      contextWindow,
      nextContextWindow: next,
      restarts: turn.oomRestarts,
    });
    return {
      kind: "stop",
      error: new LocalOutOfMemoryError(message, contextWindow, next, input.cause),
    };
  };

  if (turn.oomRestarts >= OUT_OF_MEMORY_MAX_RESTARTS) {
    return stop(
      `The model ran out of memory ${OUT_OF_MEMORY_MAX_RESTARTS} times in a row, ` +
        `even with a context window of ${contextWindow} tokens. Pick a smaller model.`,
    );
  }
  if (next === null) {
    return stop(
      contextWindow > 0
        ? `The model ran out of memory with a context window of ${contextWindow} tokens, ` +
            "and a smaller window would not leave room for the conversation. Pick a smaller model."
        : "The model ran out of memory. Pick a smaller model.",
    );
  }
  if (port === undefined || !port.canRestart()) {
    // Nothing in this process owns the model (a headless `serve`; the
    // desktop restarts it). The turn still does not wait: it ends now,
    // and the event names the window to restart with.
    return stop(
      `The model ran out of memory with a context window of ${contextWindow} tokens. ` +
        `Restart it with a smaller window (${next} tokens), or pick a smaller model.`,
    );
  }

  if (options.localOutOfMemory === "ask") {
    const questionId = randomUUID();
    const message =
      `The model ran out of memory with a context window of ${contextWindow} tokens. ` +
      `Restart it with a smaller window (${next} tokens)?`;
    event("asking", message, { questionId, options: OUT_OF_MEMORY_CHOICES });
    let choice: LocalOutOfMemoryChoice;
    try {
      choice = await port.ask(
        { questionId, sessionId: input.sessionId, contextWindow, nextContextWindow: next, message },
        options.signal,
      );
    } catch {
      if (options.signal.aborted) return { kind: "cancelled" };
      choice = "cancel";
    }
    if (options.signal.aborted) return { kind: "cancelled" };
    if (choice === "pick_smaller_model") {
      return stop("The model ran out of memory. Pick a smaller model, then send the message again.");
    }
    if (choice === "cancel") {
      return stop("The model ran out of memory. Stopped without restarting it.");
    }
  }

  turn.oomRestarts += 1;
  event("restarting", `Restarting the model with a context window of ${next} tokens.`);
  deps.logger?.warn("local model ran out of memory; restarting it with a smaller context window", {
    sessionId: input.sessionId,
    contextWindow,
    nextContextWindow: next,
    attempt,
  });
  let restarted = false;
  try {
    restarted = await port.restart(next, options.signal);
  } catch {
    restarted = false;
  }
  if (options.signal.aborted) return { kind: "cancelled" };
  if (!restarted) {
    return stop(
      `The model ran out of memory, and restarting it with a context window of ${next} tokens failed. ` +
        "Pick a smaller model.",
    );
  }
  event("restarted", formatOutOfMemoryRestarted(next));
  return { kind: "retry_same" };
}
