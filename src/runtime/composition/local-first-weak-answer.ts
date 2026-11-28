import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import { isRefusedResult } from "../../agent/review-stall.js";

/**
 * Signs that the local model's answer to a local-first turn is weak
 * (ATO-2434), read off the loop's own events. A provider error already
 * moves the turn to the cloud (`shouldAdvance`); these are the cases the
 * local model answered, but badly:
 *  - `empty`: a completion with nothing in it (`empty_completion_recovered`);
 *  - `truncated`: a completion cut off (`completion_truncated`);
 *  - `loop`: a cut reply that repeats itself, or the loop detector at
 *    `critical` or `breaker` level (`loop_detected`);
 *  - `verify-failed`: `verify.run` came back failed twice in the turn;
 *  - `tool-refusals`: two tool calls refused at dispatch (a denied or
 *    gated call, `isRefusedResult`) or two unparseable tool calls
 *    (`parse_failure_recovered`) in the turn.
 *
 * One empty, cut or looping completion is enough: the loop would retry
 * the same model on the same prompt. A failed check or a refused call
 * can be ordinary work (a test that fails before the fix), so those need
 * a second one.
 *
 * Precedent: AutoMix / FrugalGPT cascades (a cheap model's answer is
 * scored and a weak one goes to the bigger model).
 */
export type WeakAnswerSignal = "empty" | "truncated" | "loop" | "verify-failed" | "tool-refusals";

/** How many of a repeatable sign make the answer weak. */
export const WEAK_ANSWER_REPEATS = 2;

const VERIFY_TOOL = "verify.run";

export interface WeakAnswerWatch {
  /** The sign this event completes, or null. Reports each turn's first sign only. */
  observe(event: AgentLoopEvent): WeakAnswerSignal | null;
}

/** A fresh watch for one turn. */
export function createWeakAnswerWatch(): WeakAnswerWatch {
  let fired = false;
  let failedVerifies = 0;
  let refusals = 0;
  const signalOf = (event: AgentLoopEvent): WeakAnswerSignal | null => {
    switch (event.type) {
      case "empty_completion_recovered":
        return "empty";
      case "completion_truncated":
        return event.repetitive === true ? "loop" : "truncated";
      case "loop_detected":
        return event.level === "critical" || event.level === "breaker" ? "loop" : null;
      case "parse_failure_recovered":
        refusals += 1;
        return refusals >= WEAK_ANSWER_REPEATS ? "tool-refusals" : null;
      case "llm_event": {
        const step = event.event;
        if (step.type !== "tool_call_executed") return null;
        if (step.result.tool === VERIFY_TOOL && step.result.status === "error" && !isRefusedResult(step.result)) {
          failedVerifies += 1;
          return failedVerifies >= WEAK_ANSWER_REPEATS ? "verify-failed" : null;
        }
        if (isRefusedResult(step.result)) {
          refusals += 1;
          return refusals >= WEAK_ANSWER_REPEATS ? "tool-refusals" : null;
        }
        return null;
      }
      default:
        return null;
    }
  };
  return {
    observe(event) {
      if (fired) return null;
      const signal = signalOf(event);
      if (signal !== null) fired = true;
      return signal;
    },
  };
}

/** The plain words a switch notice carries for a sign. */
export function weakAnswerReason(signal: WeakAnswerSignal): string {
  switch (signal) {
    case "empty":
      return "the local model's answer was empty";
    case "truncated":
      return "the local model's answer was cut off";
    case "loop":
      return "the local model was repeating itself";
    case "verify-failed":
      return "the local model's work failed its checks twice";
    case "tool-refusals":
      return "the local model's tool calls were refused twice";
  }
}
