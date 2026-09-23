import type { CompressedToolResult } from "../compressor/result-compressor.js";
import type { StepToolSet } from "./step-tool-set.js";

/**
 * A Fusion planner that only reads is made to choose (F41).
 *
 * Live, with one failing check line in front of them, two local
 * orchestrators read for ninety minutes each and never called
 * `fusion.delegate`: every read was allowed (planning is reading), every
 * write was refused (the gate holds), and nothing said that the review
 * had to END in one of two ways. The orchestrator gate decides what a
 * call may do; this decides how long a turn may go on doing nothing but
 * that.
 *
 * The rule, per turn: count consecutive steps since the last fan-out
 * (or the turn's start) whose calls were all read-only — reads, lists,
 * greps, `verify.*`, memory reads, and any call the gates refused, which
 * changed nothing. At `N` (`llm.runMode.fusion.reviewStallSteps`,
 * default 6) the model is told once, on the `### notice` channel, that
 * a fix means `fusion.delegate` and an answer means `reply`. At `2N` the
 * step's tool set is cut to `fusion.delegate`, `reply` and `finish`
 * through the same three legs the final step uses (`step-tool-set.ts`):
 * grammar, native tools payload, dispatch gate. A model that delegates
 * resets the count and gets its full set back; one that replies ends the
 * turn with the honest state. `0` turns both off.
 *
 * A repair request halves `N` (rounded up): a turn that opens with a
 * checker's failing lines already holds the evidence a review would be
 * gathering, so the reading budget before the choice is shorter. The
 * test is a whole-word `FAIL` / `failed` / `failing` in the user message
 * — the request pin (F22) and the claim-evidence check (F9) carry the
 * request and the claims, neither classifies the message, so there is
 * nothing there to reuse.
 *
 * The count is a count of STEPS, not of calls: a batched step of eight
 * reads is one step of reading, which is what the ceiling is meant to
 * bound. A retry of the same step (parse repair, truncation, outage)
 * never completed, so it is not observed and the notice it carried
 * rides `pendingNotice` like every other notice.
 */

/** The three names a cut step admits. */
export const REVIEW_STALL_TOOL_NAMES: readonly string[] = [
  "fusion.delegate",
  "reply",
  "finish",
];

/** The status-line text for a cut step; also the refusal's opening clause. */
export const REVIEW_STALL_CUT_REASON = "review stalled: delegate or reply";

const DELEGATE_TOOL = "fusion.delegate";
const TERMINAL_TOOLS: ReadonlySet<string> = new Set(["reply", "finish"]);

export type ReviewStallPhase = "notice" | "cut";

/** What `step_finished` carries for a step that ran under the rule. */
export interface ReviewStallSignal {
  /** Consecutive read-only steps before this step ran. */
  steps: number;
  phase: ReviewStallPhase;
}

export interface ReviewStallState {
  /** `N` for this turn, after the repair halving. `0` = off. */
  threshold: number;
  /** Consecutive read-only steps since the last fan-out or the turn start. */
  readOnlySteps: number;
  /**
   * The count at which the last notice was injected, `null` for none
   * this stall. The notice phase injects once per stall; the cut phase
   * once per cut step (the count moves with every refused read).
   */
  noticedAt: number | null;
}

/**
 * Whether the turn's user message reads as a repair request: a checker's
 * failing lines pasted in, or the operator saying something failed.
 * `FAIL` is matched as written (a checker's own line); the two verbs
 * case-insensitively. Whole words only — "failure" and "unfailing" are
 * not the signal.
 */
export function looksLikeRepairRequest(
  text: string | null | undefined,
): boolean {
  if (!text) return false;
  return /\bFAIL\b/.test(text) || /\b(?:failed|failing)\b/i.test(text);
}

/** `N` for this turn: the configured value, halved (rounded up) on a repair request. */
export function resolveReviewStallThreshold(
  configured: number,
  userMessage?: string | null,
): number {
  const base = Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : 0;
  if (base === 0) return 0;
  return looksLikeRepairRequest(userMessage) ? Math.ceil(base / 2) : base;
}

export function createReviewStallState(
  configured: number,
  userMessage?: string | null,
): ReviewStallState {
  return {
    threshold: resolveReviewStallThreshold(configured, userMessage),
    readOnlySteps: 0,
    noticedAt: null,
  };
}

/**
 * A result that stands for a call the runtime refused before dispatch:
 * the orchestrator gate, plan mode, the final step, a tool set, the
 * loop veto. None of them ran, so none of them changed anything.
 */
export function isRefusedResult(result: CompressedToolResult): boolean {
  if (result.status !== "error") return false;
  const d = result.details;
  return (
    d.fusion_orchestrator === true ||
    d.plan_mode === true ||
    d.final_step === true ||
    d.tool_set === true ||
    typeof d.deniedReason === "string"
  );
}

/** Whether a `fusion.delegate` call actually ran this step. */
export function stepDelegated(
  results: readonly CompressedToolResult[],
): boolean {
  return results.some((r) => r.tool === DELEGATE_TOOL && !isRefusedResult(r));
}

/**
 * Whether every call of the step left the world as it was: terminals
 * (a reply is shown, not run — a progress note included), refusals, and
 * calls `mutates` does not flag. The predicate is the orchestrator
 * gate's own (`wouldRefuse`), so this and the gate cannot disagree about
 * which tools change things.
 */
export function stepChangedNothing(
  results: readonly CompressedToolResult[],
  mutates: (tool: string) => boolean,
): boolean {
  return results.every(
    (r) =>
      TERMINAL_TOOLS.has(r.tool) ||
      isRefusedResult(r) ||
      (r.tool !== DELEGATE_TOOL && !mutates(r.tool)),
  );
}

export interface ReviewStepObservation {
  results: readonly CompressedToolResult[];
  /** Does a call to `tool` change anything — the orchestrator gate's `wouldRefuse`. */
  mutates: (tool: string) => boolean;
}

/**
 * Fold a completed step in. A fan-out resets the count and re-arms the
 * notice; a step of reading (or of refusals) adds one; a step in which
 * something actually mutated breaks the run the same way a fan-out
 * does — it cannot happen on an orchestrator turn, whose gate refuses
 * every mutation, but the rule is about consecutive read-only steps
 * and says so.
 */
export function observeReviewStep(
  state: ReviewStallState,
  step: ReviewStepObservation,
): ReviewStallState {
  if (state.threshold === 0) return state;
  if (stepDelegated(step.results)) {
    return { ...state, readOnlySteps: 0, noticedAt: null };
  }
  if (stepChangedNothing(step.results, step.mutates)) {
    return { ...state, readOnlySteps: state.readOnlySteps + 1 };
  }
  return { ...state, readOnlySteps: 0, noticedAt: null };
}

/** The phase the NEXT step runs under, or `null` while the review is not stalled. */
export function reviewStallSignal(
  state: ReviewStallState,
): ReviewStallSignal | null {
  if (state.threshold <= 0) return null;
  if (state.readOnlySteps >= 2 * state.threshold) {
    return { steps: state.readOnlySteps, phase: "cut" };
  }
  if (state.readOnlySteps >= state.threshold) {
    return { steps: state.readOnlySteps, phase: "notice" };
  }
  return null;
}

/**
 * The `### notice` text for a step under `signal`, and the state that
 * remembers it was given: once per stall in the notice phase, once per
 * cut step in the cut phase. `null` when the step is owed nothing new.
 */
export function takeReviewStallNotice(
  state: ReviewStallState,
  signal: ReviewStallSignal,
): { state: ReviewStallState; notice: string | null } {
  const due =
    signal.phase === "cut"
      ? state.noticedAt !== signal.steps
      : state.noticedAt === null;
  if (!due) return { state, notice: null };
  return {
    state: { ...state, noticedAt: signal.steps },
    notice: formatReviewStallNotice(signal),
  };
}

/**
 * What the model is told. The count, the one fact it may not have
 * drawn (in Fusion it cannot edit), and the two exits by name. The cut
 * step says what it admits, because the reads it would reach for are
 * refused and it must not read the refusal as a broken tool.
 */
export function formatReviewStallNotice(signal: ReviewStallSignal): string {
  const head =
    `${signal.steps} steps of reading and no fan-out. In Fusion you cannot ` +
    "edit; a fix means `fusion.delegate` with the change spelled out, or " +
    "`reply` with what stands. Next step: delegate or reply.";
  if (signal.phase !== "cut") return head;
  return (
    `${head} This step runs only \`fusion.delegate\`, \`reply\` or ` +
    "`finish`; any other call is refused."
  );
}

/** The cut step's tool set, for `StepContext.toolSet`. */
export function reviewStallToolSet(): StepToolSet {
  return { names: REVIEW_STALL_TOOL_NAMES, reason: REVIEW_STALL_CUT_REASON };
}
