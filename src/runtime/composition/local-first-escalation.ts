import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import type { ProviderFallbackChain } from "../../llm/fallback/index.js";
import type { LlmFallbackConfig } from "../../llm/provider/registry/provider-types.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { createWeakAnswerWatch, weakAnswerReason, type WeakAnswerWatch } from "./local-first-weak-answer.js";

/**
 * The cloud part of a local-first turn (ATO-2434): a weak local answer
 * goes on in the cloud mid-turn, and the cloud spend of such turns has a
 * per-turn and a per-day ceiling.
 *
 * `begin` is called by `executeTurn` when the cascade put the local link
 * first for the turn (`routeTurnProvider`), `end` when the turn is over.
 * `observe` sees every loop event of the session (bootstrap's loop
 * `onEvent`); the first weak-answer sign (`local-first-weak-answer.ts`)
 * while the turn is still on its local head moves the session's chain
 * to the next link for the rest of the turn
 * (`ProviderFallbackChain.escalateTurnHead`), announced like a fallover.
 */
export interface LocalFirstEscalation {
  begin(sessionId: string, headId: string): void;
  end(sessionId: string): void;
  observe(sessionId: string | undefined, event: AgentLoopEvent): void;
}

export interface LocalFirstEscalationDeps {
  chain: Pick<ProviderFallbackChain, "escalateTurnHead" | "standingOverrideFor">;
  logger: Pick<StructuredLogger, "info">;
}

export function createLocalFirstEscalation(deps: LocalFirstEscalationDeps): LocalFirstEscalation {
  const turns = new Map<string, { headId: string; watch: WeakAnswerWatch }>();
  return {
    begin(sessionId, headId) {
      turns.set(sessionId, { headId, watch: createWeakAnswerWatch() });
    },
    end(sessionId) {
      turns.delete(sessionId);
    },
    observe(sessionId, event) {
      if (sessionId === undefined) return;
      const turn = turns.get(sessionId);
      if (turn === undefined) return;
      const signal = turn.watch.observe(event);
      if (signal === null) return;
      turns.delete(sessionId);
      // A provider failure already moved the turn: nothing to escalate.
      if (deps.chain.standingOverrideFor(sessionId) !== turn.headId) return;
      const to = deps.chain.escalateTurnHead(sessionId, weakAnswerReason(signal));
      if (to === null) return;
      deps.logger.info("local-first cascade: weak local answer, turn goes on in the cloud", {
        sessionId,
        signal,
        providerId: to,
      });
    },
  };
}

/**
 * The loop's `onEvent` with the watch in front: the watch sees the event
 * (and may move the chain) before it is fanned out.
 */
export function withLocalFirstWatch(
  escalation: Pick<LocalFirstEscalation, "observe">,
  sessionIdOf: () => string | undefined,
  emit: (event: AgentLoopEvent) => void,
): (event: AgentLoopEvent) => void {
  return (event) => {
    escalation.observe(sessionIdOf(), event);
    emit(event);
  };
}

/** What a local-first turn may do in the cloud. */
export interface LocalFirstTurnPolicy {
  /** Hand a weak local answer to the cloud. */
  escalate: boolean;
  /** The turn's spend ceiling, USD, when one applies. */
  maxCostUsd?: number;
}

/**
 * The smallest ceiling the loop honours: `0` means "no cap" there, so a
 * spent day budget is a ceiling of a fraction of a cent, reached by the
 * first priced step (the loop checks after each step).
 */
export const SPENT_BUDGET_CEILING_USD = 0.000001;

/**
 * The cloud allowance of a local-first turn. `escalate` follows
 * `localFirstEscalate` (default true) and is off once today's spend
 * reaches `localFirstMaxDayUsd`. The ceiling is the smallest of
 * `localFirstMaxTurnUsd`, what is left of `localFirstMaxDayUsd` today,
 * and the turn's own task ceiling (`taskMaxCostUsd`, `0` = none). Local
 * steps are unpriced, so only the cloud part counts.
 */
export function localFirstTurnPolicy(input: {
  fallback: Pick<LlmFallbackConfig, "localFirstEscalate" | "localFirstMaxTurnUsd" | "localFirstMaxDayUsd"> | undefined;
  todayUsd: number | undefined;
  taskMaxCostUsd: number | undefined;
}): LocalFirstTurnPolicy {
  const fallback = input.fallback ?? {};
  const dayCap = fallback.localFirstMaxDayUsd;
  const left = dayCap === undefined ? undefined : dayCap - (input.todayUsd ?? 0);
  const caps = [
    fallback.localFirstMaxTurnUsd,
    left,
    input.taskMaxCostUsd !== undefined && input.taskMaxCostUsd > 0 ? input.taskMaxCostUsd : undefined,
  ].filter((v): v is number => v !== undefined && Number.isFinite(v));
  const escalate = fallback.localFirstEscalate !== false && (left === undefined || left > 0);
  if (caps.length === 0) return { escalate };
  return { escalate, maxCostUsd: Math.max(Math.min(...caps), SPENT_BUDGET_CEILING_USD) };
}
