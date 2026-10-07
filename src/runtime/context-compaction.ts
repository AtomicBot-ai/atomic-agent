import type { ContextCompactionControl, CompactionStepOptions } from "../agent/compaction-control.js";
import type { CompactionConfig } from "../config/agent/compaction-config.js";
import { buildPrompt } from "../prompt/build-prompt.js";
import type { BuildPromptInput } from "../prompt/build-prompt-types.js";
import { planCompaction } from "../prompt/plan-compaction.js";
import { validSessionCompaction, type CompactionResult } from "../session/session-compaction.js";
import type { SessionState } from "../session/session-state.js";
import type { SessionStore } from "../session/session-store.js";
import type { TurnController } from "./turn-controller.js";
import { SessionNotFoundError } from "./session-not-found-error.js";
import { runContextCompaction, type CompactionRunnerDependencies } from "./context-compaction-runner.js";

interface ManualRequest {
  controller: AbortController;
  signal: AbortSignal;
  running: boolean;
  queued: boolean;
  settle(result: CompactionResult): void;
}

export interface ContextCompactionDependencies extends CompactionRunnerDependencies {
  config(): CompactionConfig;
  warn?(sessionId: string, message: string): void;
  sessionStore: Pick<SessionStore, "load">;
  turnController: Pick<TurnController, "enqueue">;
  promptInput(state: SessionState): BuildPromptInput;
}

/** A control inbox, separate from user messages and from the FIFO's occupied lock. */
export function createContextCompaction(deps: ContextCompactionDependencies) {
  const accepting = new Map<string, AbortSignal>();
  const requests = new Map<string, ManualRequest>();
  const active = new Map<string, AbortController>();
  const autoFailed = new Set<string>();
  let stopped = false;
  const warned = new Set<string>();
  function diagnose(state: SessionState) {
    if (state.compactionWarning && !warned.has(state.id)) {
      warned.add(state.id); deps.warn?.(state.id, state.compactionWarning);
    }
  }
  const cancelled = (): CompactionResult => ({ status: "cancelled", reason: "manual" });

  function load(id: string) {
    const session = deps.sessionStore.load(id);
    if (!session) throw new SessionNotFoundError(id);
    diagnose(session);
    return session;
  }

  function perform(input: BuildPromptInput, options: CompactionStepOptions, request?: ManualRequest, inTurn = true): Promise<SessionState> | undefined {
    if (stopped || options.signal.aborted) { request?.settle(cancelled()); return undefined; }
    diagnose(input.session);
    const config = deps.config();
    if (!request && !options.requested && (autoFailed.has(input.session.id) || !config.auto)) return undefined;
    const plan = planCompaction(input.session, buildPrompt(input), config, request ? "manual" : options.requested);
    if (!plan) { request?.settle({ status: "noop", reason: request ? "manual" : options.requested ?? "threshold", message: "No safe, useful reduction is available." }); return undefined; }
    const controller = request?.controller ?? new AbortController();
    active.set(input.session.id, controller);
    if (request) request.running = true;
    const signal = AbortSignal.any([options.signal, request?.signal ?? controller.signal]);
    const release = () => { if (active.get(input.session.id) === controller) active.delete(input.session.id); };
    return runContextCompaction(input, plan, config, { ...options, signal, inTurn }, deps)
      .then(({ state, result }) => {
        if (result.status === "failed" && plan.reason !== "manual") autoFailed.add(input.session.id);
        release();
        request?.settle(result);
        return state;
      }).finally(release);
  }

  function enqueue(id: string, request: ManualRequest) {
    request.queued = true;
    void deps.turnController.enqueue({
      sessionId: id, origin: "cli", signal: request.signal,
      run: async () => {
        if (request.signal.aborted || stopped) { request.settle(cancelled()); return; }
        const state = load(id); // Read under the lock, never use a frontend's mirror.
        await perform(deps.promptInput(state), { signal: request.signal }, request, false);
      },
    }).catch((error: unknown) => {
      const result: CompactionResult = request.signal.aborted ? cancelled() : {
        status: "failed", reason: "manual", message: error instanceof Error ? error.message : String(error),
      };
      try {
        deps.emit({ type: "compaction_failed", sessionId: id, result,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, calls: 0 });
      } catch { /* An observer must not strand the control request. */ }
      request.settle(result);
    });
  }

  const control: ContextCompactionControl = {
    open(id, signal) { accepting.set(id, signal); autoFailed.delete(id); },
    close(id) {
      accepting.delete(id);
      autoFailed.delete(id);
      const request = requests.get(id);
      // Enqueue without awaiting: the caller still owns the turn lock here.
      if (request && !request.running && !request.queued) enqueue(id, request);
    },
    beforeStep(input, options) {
      const request = requests.get(input.session.id);
      return perform(input, options, request?.queued ? undefined : request);
    },
  };

  return {
    control,
    compactSession(id: string, options: { signal?: AbortSignal } = {}): Promise<CompactionResult> {
      if (stopped || options.signal?.aborted) return Promise.resolve(cancelled());
      if (requests.has(id) || active.has(id)) return Promise.resolve({ status: "busy", reason: "manual" });
      const turnSignal = accepting.get(id);
      if (!turnSignal) load(id);
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : []), ...(turnSignal ? [turnSignal] : [])]);
      return new Promise((resolve) => {
        const onAbort = () => { if (!request.running) request.settle(cancelled()); };
        const request: ManualRequest = {
          controller, signal, running: false, queued: false,
          settle(result) {
            if (requests.get(id) === request) requests.delete(id);
            signal.removeEventListener("abort", onAbort);
            resolve(result);
          },
        };
        requests.set(id, request);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        else if (!turnSignal) enqueue(id, request);
      });
    },
    getSessionCompaction(id: string) { return validSessionCompaction(load(id)); },
    cancelSessionCompaction(id: string) {
      const hadOperation = requests.has(id) || active.has(id);
      requests.get(id)?.controller.abort(); active.get(id)?.abort();
      return hadOperation;
    },
    shutdown() {
      stopped = true;
      for (const request of requests.values()) request.controller.abort();
      for (const controller of active.values()) controller.abort();
      accepting.clear();
      autoFailed.clear();
      warned.clear();
    },
  };
}
