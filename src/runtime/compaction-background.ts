import type { LlmStreamParams } from "../agent/step/step-contract.js";
import type { CompactionConfig } from "../config/agent/compaction-config.js";
import type { CompletionResult } from "../llm/provider/completion-types.js";
import { buildPrompt } from "../prompt/build-prompt.js";
import type { BuildPromptInput } from "../prompt/build-prompt-types.js";
import { planCompaction } from "../prompt/plan-compaction.js";
import { compactionBoundaryHash, summaryTextHash, validRollingSummary, validSessionCompaction } from "../session/session-compaction.js";
import type { SessionState } from "../session/session-state.js";
import type { SessionStore } from "../session/session-store.js";
import { isFusionWorkerSessionId } from "../session/fusion-worker-session.js";
import type { CompactionRouteFacts } from "./compaction-mode.js";
import { estimateTokens } from "../prompt/token-budget.js";
import { renderRollingSource, ROLLING_JOB_MAX_SOURCE_TOKENS, ROLLING_MIN_SOURCE_TOKENS, ROLLING_SUMMARY_SHARE } from "./compaction-rolling.js";
import { modelSummaryFailure, summarizeWithModel, type ModelSummaryRoute, type ModelSummaryTally } from "./context-compaction-model.js";

/** Quiet time after a turn ends before a job starts; the turn's own save lands first. */
export const BACKGROUND_IDLE_DELAY_MS = 2_000;
/** Jobs start once history reaches this share of the automatic trigger. */
export const BACKGROUND_START_SHARE_OF_TRIGGER = 0.5;
/** Cloud routes cost money per call: they also wait for half the history allowance. */
export const BACKGROUND_CLOUD_START_SHARE = 0.5;
/** Ceiling of one job's model call, below the foreground `timeoutMs`. */
export const BACKGROUND_TIMEOUT_MS = 300_000;

export interface BackgroundCompactionDependencies {
  config(): CompactionConfig;
  sessionStore: Pick<SessionStore, "load" | "save">;
  /** No turn runs on any session: background work never competes with one. */
  isIdle(): boolean;
  /** A turn runs on this session and holds its own copy of the state. */
  isBusy(sessionId: string): boolean;
  promptInput(state: SessionState): BuildPromptInput;
  route(sessionId: string): ModelSummaryRoute & CompactionRouteFacts;
  sideCallSlotId(): number;
  complete(params: LlmStreamParams): Promise<CompletionResult>;
  costOf?(result: CompletionResult, providerId: string): number | undefined;
  log?(level: "info" | "warn", message: string, fields: Record<string, unknown>): void;
  delayMs?: number;
}

export interface BackgroundCompaction {
  /** A turn on this session ended: extend its rolling summary once the runtime is idle. */
  schedule(sessionId: string): void;
  /** A turn or step starts, or compaction runs: stop pending and running work. */
  cancel(sessionId: string): void;
  shutdown(): void;
}

/**
 * Extends each session's rolling summary between turns, one bounded job at
 * a time across the runtime, so a later compaction can use it without a
 * model call. Never blocks a turn: any turn start aborts the running job.
 */
export function createBackgroundCompaction(deps: BackgroundCompactionDependencies): BackgroundCompaction {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Sessions whose job ran out of time: the same input would again, so they wait for a restart.
  const timedOut = new Set<string>();
  let running: { sessionId: string; controller: AbortController } | undefined;
  let stopped = false;
  const delay = deps.delayMs ?? BACKGROUND_IDLE_DELAY_MS;

  function schedule(sessionId: string) {
    // Fusion workers are throwaway sessions on their own provider pin.
    if (stopped || timedOut.has(sessionId) || isFusionWorkerSessionId(sessionId) || deps.config().background === false) return;
    clearTimeout(timers.get(sessionId));
    const timer = setTimeout(() => { timers.delete(sessionId); void run(sessionId); }, delay);
    timer.unref?.();
    timers.set(sessionId, timer);
  }

  async function run(sessionId: string) {
    if (stopped) return;
    if (running) { if (running.sessionId !== sessionId) schedule(sessionId); return; }
    if (!deps.isIdle()) { schedule(sessionId); return; }
    const controller = new AbortController();
    running = { sessionId, controller };
    let more = false;
    try {
      more = await extend(sessionId, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) deps.log?.("warn", "background compaction summary failed", { sessionId, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (running?.controller === controller) running = undefined;
    }
    if (more && !controller.signal.aborted) schedule(sessionId);
  }

  /** One job; true when records are left for another. */
  async function extend(sessionId: string, signal: AbortSignal): Promise<boolean> {
    const config = deps.config();
    if (config.background === false || config.mode !== "auto" || !config.auto) return false;
    const state = deps.sessionStore.load(sessionId);
    if (!state) return false;
    const route = deps.route(sessionId);
    // On a single llama-server slot, a side call would evict the main
    // conversation's cache; a model without prefix reuse re-reads it all.
    const slot = route.local ? deps.sideCallSlotId() : -1;
    if (route.local && slot === -1) return false;
    const input = deps.promptInput(state);
    const prompt = buildPrompt(input);
    const budget = prompt.compactionBudget;
    if (!budget) return false;
    const start = budget.cap * config.triggerRatio * BACKGROUND_START_SHARE_OF_TRIGGER;
    if (budget.activeTokens < (route.local ? start : Math.max(start, budget.cap * BACKGROUND_CLOUD_START_SHARE))) return false;
    // Where a compaction would cut now. Later cuts only move forward, so the summary stays behind them.
    const prefixReuse = input.profileWindowApplies === false ? undefined : input.profile?.prefixReuse;
    const plan = planCompaction(state, prompt, config, "overflow", prefixReuse ? { prefixReuse } : {});
    if (!plan) return false;
    const base = validSessionCompaction(state);
    const rolling = validRollingSummary(state);
    const from = rolling?.coveredThrough ?? plan.from;
    const maxTokens = Math.floor(plan.summaryMaxTokens * ROLLING_SUMMARY_SHARE);
    const window = Math.min(route.contextWindow ?? Infinity, prompt.contextWindow ?? prompt.conversationCapEffective);
    const sourceCap = Math.min(ROLLING_JOB_MAX_SOURCE_TOKENS, Math.floor((window - maxTokens - 1024) / 2));
    if (maxTokens < 64 || sourceCap < 512) return false;
    const source = renderRollingSource(state.turns, from, plan.through, sourceCap);
    if (!source || estimateTokens(source.text) < ROLLING_MIN_SOURCE_TOKENS) return false;
    const limit = Math.min(BACKGROUND_TIMEOUT_MS, config.timeoutMs);
    const jobConfig: CompactionConfig = { ...config, timeoutMs: limit, maxTotalTimeoutMs: Math.min(limit, config.maxTotalTimeoutMs) };
    const tally: ModelSummaryTally = { usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, calls: 0, chunkCount: 0, totalTimeoutMs: limit };
    let written: { summary: string; model: string | null };
    try {
      written = await summarizeWithModel({
        input, prompt, plan: { ...plan, from, through: source.through, summaryMaxTokens: maxTokens }, config: jobConfig, route,
        previous: rolling?.summary ?? base?.summary ?? "",
        source: { text: source.text, maxContextTokens: 0, contextAt: () => "" },
        signal, tally, emit: () => {}, complete: deps.complete, sideCallSlotId: () => slot,
        ...(deps.costOf ? { costOf: deps.costOf } : {}),
      });
    } catch (error) {
      if (!signal.aborted && modelSummaryFailure(error, tally, jobConfig).timedOut) timedOut.add(sessionId);
      throw error;
    }
    // A turn on this session holds its own copy of the state and would overwrite this write.
    if (signal.aborted || stopped || deps.isBusy(sessionId)) return false;
    const fresh = deps.sessionStore.load(sessionId);
    if (!fresh) return false;
    const freshBase = validSessionCompaction(fresh);
    const last = fresh.turns[source.through - 1];
    if ((freshBase?.coveredThrough ?? 0) !== plan.from || freshBase?.summary !== base?.summary || !last ||
        compactionBoundaryHash(last) !== compactionBoundaryHash(state.turns[source.through - 1]!) ||
        (validRollingSummary(fresh)?.coveredThrough ?? plan.from) !== from) return false;
    deps.sessionStore.save({ ...fresh, rollingSummary: {
      version: 1, summary: written.summary, from: plan.from, baseHash: summaryTextHash(base?.summary ?? ""),
      coveredThrough: source.through, boundaryHash: compactionBoundaryHash(last), createdAt: Date.now(), model: written.model,
    } });
    deps.log?.("info", "background compaction summary extended", { sessionId, coveredThrough: source.through, calls: tally.calls });
    return source.through < plan.through;
  }

  return {
    schedule,
    cancel(sessionId) {
      clearTimeout(timers.get(sessionId));
      timers.delete(sessionId);
      if (!running) return;
      // Any turn shares the machine (and a local GPU) with the job: stop it,
      // and let another session's job resume once the runtime is idle again.
      const { sessionId: owner, controller } = running;
      controller.abort();
      running = undefined;
      if (owner !== sessionId) schedule(owner);
    },
    shutdown() {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      running?.controller.abort();
      running = undefined;
      timedOut.clear();
    },
  };
}
