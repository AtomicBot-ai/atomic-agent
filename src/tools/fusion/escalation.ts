import type { CompletionUsage } from "../../llm/provider/completion-types.js";
import { estimateUsageCostUsd } from "../../llm/provider/usage-cost.js";
import type { FusionEscalationTarget } from "../../llm/run-mode/index.js";
import type { WorkerPricing } from "./worker-result.js";

/**
 * Escalating a stuck worker to a stronger model (ATO-942, ATO-66).
 *
 * The advisor path: the escalation model reads a compressed trace of
 * the node (its brief, what it has done, why it looks stuck) and answers
 * with a short hint, which reaches the worker as a mid-turn steer; the
 * worker carries on. The replacement path (behind `escalationReplace`)
 * re-runs the task on the escalation model with what was found.
 *
 * Escalation only ever goes to `ResolvedRunMode.escalation`, a provider
 * the operator configured (the orchestrator leg by default), and every
 * call is priced before and after: a call whose worst case is over the
 * per-escalation cap is not made, and the row says what it cost.
 */

/** Room for a 400–700 token hint, and no more. */
export const ADVISOR_MAX_OUTPUT_TOKENS = 700;
/** How much of the brief the advisor reads; the rest is the trace. */
export const ADVISOR_BRIEF_CHARS = 3_000;

export type EscalationTrigger =
  | { kind: "stall"; detail: string }
  | { kind: "first-answer-cut"; detail: string }
  | { kind: "manual" };

export function describeTrigger(trigger: EscalationTrigger): string {
  if (trigger.kind === "manual") return "the person asked for it";
  if (trigger.kind === "stall") return `stalled: ${trigger.detail}`;
  return `first answer cut: ${trigger.detail}`;
}

/** One escalation completion, on a pinned provider, no fallback. */
export type EscalationComplete = (input: {
  providerId: string;
  prompt: string;
  maxOutputTokens: number;
  signal: AbortSignal;
}) => Promise<{ content: string; usage?: CompletionUsage }>;

export function renderAdvisorPrompt(input: {
  brief: string;
  trigger: EscalationTrigger;
  findings: string;
}): string {
  const brief =
    input.brief.length > ADVISOR_BRIEF_CHARS
      ? `${input.brief.slice(0, ADVISOR_BRIEF_CHARS)}\n[… brief truncated]`
      : input.brief;
  return [
    "You are advising a smaller model that is working on one task and appears to be stuck.",
    "Read its brief and what it has done so far, then reply with concrete next steps it can follow: what to do next, which file to write or command to run, and what to stop doing. Under 500 words. No preamble, no code longer than a few lines.",
    "",
    "## Brief",
    brief,
    "",
    "## Why it looks stuck",
    describeTrigger(input.trigger),
    "",
    "## What it has done so far",
    input.findings,
  ].join("\n");
}

/** The steer the worker reads at its next step. */
export function formatAdvisorSteer(model: string, hint: string): string {
  return `Advice from a stronger model (${model}) after your recent steps looked stuck. Follow it unless your files show it is wrong:\n\n${hint.trim()}`;
}

/** Worst case of a call: the whole prompt uncached plus the full reply. */
export function worstCaseCostUsd(
  promptChars: number,
  maxOutputTokens: number,
  pricing: WorkerPricing,
): number {
  return (
    (promptChars / 4 / 1_000_000) * pricing.input +
    (maxOutputTokens / 1_000_000) * pricing.output
  );
}

export type AdviceOutcome =
  | { ok: true; hint: string; costUsd: number | null; usage?: CompletionUsage }
  | { ok: false; reason: string; costUsd: number | null };

/**
 * Ask the escalation model for a hint. Never throws: a refusal (cap,
 * empty answer, provider error) comes back as a reason for the row.
 */
export async function requestAdvice(input: {
  target: FusionEscalationTarget;
  pricing: WorkerPricing | undefined;
  prompt: string;
  complete: EscalationComplete;
  signal: AbortSignal;
}): Promise<AdviceOutcome> {
  const { target, pricing } = input;
  if (pricing !== undefined) {
    const worst = worstCaseCostUsd(
      input.prompt.length,
      ADVISOR_MAX_OUTPUT_TOKENS,
      pricing,
    );
    if (worst > target.maxUsd) {
      return {
        ok: false,
        reason: `its worst case (${formatCost(worst)}) is over the escalation cap (${formatCost(target.maxUsd)}, llm.runMode.fusion.escalationMaxUsd)`,
        costUsd: null,
      };
    }
  }
  try {
    const answer = await input.complete({
      providerId: target.providerId,
      prompt: input.prompt,
      maxOutputTokens: ADVISOR_MAX_OUTPUT_TOKENS,
      signal: input.signal,
    });
    const costUsd =
      pricing === undefined || answer.usage === undefined
        ? null
        : estimateUsageCostUsd(answer.usage, pricing);
    const hint = answer.content.trim();
    if (hint.length === 0) {
      return { ok: false, reason: "the escalation model sent no answer", costUsd };
    }
    return {
      ok: true,
      hint,
      costUsd,
      ...(answer.usage === undefined ? {} : { usage: answer.usage }),
    };
  } catch (err) {
    return {
      ok: false,
      reason: `the escalation call failed: ${err instanceof Error ? err.message : String(err)}`,
      costUsd: null,
    };
  }
}

export function formatCost(usd: number | null): string {
  if (usd === null) return "cost unknown (no price for this model)";
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/**
 * The live workers of every running fan-out, so the person can act on
 * one (ATO-66 and the TUI's stop / escalate actions). Keyed by the
 * parent session and the task id; an entry lives exactly as long as its
 * worker turn.
 */
export interface LiveWorkerControls {
  stop(): void;
  /** Resolves with what happened, in one line for the feed. */
  escalate(): Promise<string>;
}

export class FusionLiveWorkers {
  private readonly workers = new Map<string, LiveWorkerControls>();

  private key(parentSessionId: string, taskId: string): string {
    return `${parentSessionId}\u0000${taskId}`;
  }

  register(
    parentSessionId: string,
    taskId: string,
    controls: LiveWorkerControls,
  ): () => void {
    const key = this.key(parentSessionId, taskId);
    this.workers.set(key, controls);
    return () => {
      if (this.workers.get(key) === controls) this.workers.delete(key);
    };
  }

  /** `false` when no such worker is running. */
  stop(parentSessionId: string, taskId: string): boolean {
    const worker = this.workers.get(this.key(parentSessionId, taskId));
    if (worker === undefined) return false;
    worker.stop();
    return true;
  }

  /** `null` when no such worker is running. */
  async escalate(
    parentSessionId: string,
    taskId: string,
  ): Promise<string | null> {
    const worker = this.workers.get(this.key(parentSessionId, taskId));
    if (worker === undefined) return null;
    return worker.escalate();
  }

  running(parentSessionId: string): string[] {
    const prefix = `${parentSessionId}\u0000`;
    return [...this.workers.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }
}
