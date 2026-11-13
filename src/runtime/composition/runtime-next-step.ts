import type { AtomicAgentConfig } from "../../config/index.js";
import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import type { LlmStreamParams } from "../../agent/step/step-contract.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { ToolCallTransport } from "../../llm/provider/completion-types.js";
import type { SlotManager } from "../../llm/slot-manager.js";
import type { SessionStore } from "../../session/session-store.js";
import {
  NEXT_STEP_TIMEOUT_MS,
  SESSION_NEXT_STEP_METADATA_KEY,
  generateNextStep,
  nextStepSuggestionsEnabled,
  shouldSuggestNextStep,
  turnInFlight,
  type SessionNextStep,
  type SessionState,
} from "../../session/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { TurnOrigin } from "../turn-controller.js";

/**
 * Post-turn next-step suggestion (ATO-1093), wired like the session
 * namer: fired as a bare `void` after the turn is saved, its own
 * deadline, its abort handle in the shared teardown set, and a
 * read-modify-write against the store when the answer arrives.
 */
export interface NextStepSuggesterDeps {
  getConfig: () => AtomicAgentConfig;
  sessionStore: Pick<SessionStore, "save" | "load">;
  llmComplete: (params: LlmStreamParams) => Promise<CompletionResult>;
  slotManager: Pick<SlotManager, "sideCallSlotId">;
  resolveTransport: () => ToolCallTransport;
  /** Teardown's handles (`pendingSessionNamings`, shared with naming). */
  pending: Set<AbortController>;
  isShutdown: () => boolean;
  /**
   * Live delivery to the session's surfaces once the suggestion is
   * stored: `{ type: "next_step_suggestion", text }`, after the turn's
   * `turn_finished`. Optional; without it the suggestion is only stored.
   */
  emitEvent?: (sessionId: string, event: AgentLoopEvent) => void;
  logger: StructuredLogger;
}

/** Nobody is watching a scheduled or fusion-worker turn's reply. */
const UNWATCHED_ORIGINS: ReadonlySet<TurnOrigin> = new Set(["scheduler", "fusion"]);

/** Re-exported for callers of this recipe; the rule lives in session. */
export { nextStepSuggestionsEnabled };

export function createNextStepSuggester(deps: NextStepSuggesterDeps) {
  const store = async (state: SessionState): Promise<void> => {
    if (deps.isShutdown()) return;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), NEXT_STEP_TIMEOUT_MS);
    timer.unref?.();
    deps.pending.add(abort);
    try {
      const text = await generateNextStep(state, {
        complete: async (params) => {
          const result = await deps.llmComplete({ ...params, signal: abort.signal });
          return {
            content: result.content,
            ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
          };
        },
        slotId: () => deps.slotManager.sideCallSlotId(),
        toolTransport: deps.resolveTransport(),
        serverTemplate: deps.getConfig().localModels.useServerTemplate !== "off",
        onError: (err: unknown) =>
          deps.logger.debug("next-step suggestion failed", {
            sessionId: state.id,
            error: err instanceof Error ? err.message : String(err),
          }),
      });
      if (text === null || deps.isShutdown()) return;
      const current = deps.sessionStore.load(state.id) ?? state;
      // A newer turn already ran (or is running): this suggestion is for
      // a reply the operator has moved past.
      if (current.turnCount !== state.turnCount || turnInFlight(current.status)) return;
      const stamp: SessionNextStep = { text, afterTurn: state.turnCount, at: Date.now() };
      deps.sessionStore.save({
        ...current,
        metadata: { ...current.metadata, [SESSION_NEXT_STEP_METADATA_KEY]: stamp },
      });
      deps.emitEvent?.(state.id, { type: "next_step_suggestion", text });
    } catch (err) {
      deps.logger.warn("next-step suggestion failed to store", {
        sessionId: state.id,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timer);
      deps.pending.delete(abort);
    }
  };

  /**
   * Fire the suggestion for a finished turn when the setting, the
   * origin and the transcript all allow it. Never awaits the call and
   * never throws: the caller has already saved and is about to return.
   */
  const maybeSuggest = (state: SessionState, origin: TurnOrigin | undefined): void => {
    try {
      if (origin !== undefined && UNWATCHED_ORIGINS.has(origin)) return;
      if (!nextStepSuggestionsEnabled(deps.getConfig())) return;
      if (!shouldSuggestNextStep(state)) return;
      void store(state);
    } catch (err) {
      deps.logger.warn("next-step suggestion skipped", {
        sessionId: state.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return { maybeSuggest };
}
