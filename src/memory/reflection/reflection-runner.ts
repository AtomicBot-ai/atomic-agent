import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { AgentMetrics } from "../../telemetry/agent-metrics.js";
import type { StructuredLogger } from "../../telemetry/structured-logger.js";

import {
  ProfileStore,
  ProfileValidationError,
} from "../profile-store.js";

import { REFLECTION_GRAMMAR } from "./reflection-grammar.js";
import { parseReflectionOutput } from "./reflection-parser.js";
import { buildReflectionPrompt } from "./reflection-prompt.js";

export interface ReflectionInput {
  sessionId: string;
  userMessage: string;
  assistantReply: string;
}

/**
 * Canonical outcome taxonomy surfaced to logs and metrics. Keep this
 * union in sync with `AgentMetrics.recordReflection` — dashboards
 * aggregate it verbatim.
 */
export type ReflectionOutcome =
  | "ok"
  | "none"
  | "aborted"
  | "timeout"
  | "failed";

export interface ReflectionRunner {
  /** Fire-safe. Never throws. Never awaited by the agent loop. */
  reflect(input: ReflectionInput): Promise<void>;
  /** Aborts the currently in-flight reflection, if any. */
  abortPending(): void;
}

export type ReflectionLlmComplete = (params: {
  prompt: string;
  grammar: string;
  slotId: number;
  sessionId: string;
  signal: AbortSignal;
}) => Promise<CompletionResult>;

export interface ReflectionRunnerDeps {
  llmComplete: ReflectionLlmComplete;
  profileStore: ProfileStore;
  /**
   * Dedicated reflection slot. Passed straight to llama-server. `-1`
   * means "no slot affinity / no cache reuse" — still safe because the
   * main agent slot is never touched.
   */
  reflectionSlotId: number;
  /** Hard timeout per reflection call. */
  timeoutMs: number;
  /** Upper bound on facts written per reflection call. */
  maxFactsPerCall: number;
  logger?: StructuredLogger;
  metrics?: AgentMetrics;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Orchestrates one reflection call: builds the micro-prompt, asks
 * llama-server for a grammar-constrained completion on the dedicated
 * reflection slot, parses the output, and upserts the extracted facts
 * into the existing profile store.
 *
 * Invariants:
 *  - `reflect()` is fire-safe: all errors are swallowed into logs +
 *    metrics. The caller can `void runner.reflect(input)` safely.
 *  - At most one reflection is in flight at a time. A new `reflect()`
 *    call aborts the previous one before starting.
 *  - `abortPending()` can be called from anywhere (e.g. the start of
 *    the next agent turn) to cancel the in-flight reflection.
 */
export function createReflectionRunner(
  deps: ReflectionRunnerDeps,
): ReflectionRunner {
  const now = deps.now ?? Date.now;

  let pending: AbortController | null = null;

  const finish = (outcome: ReflectionOutcome, context: {
    sessionId: string;
    startedAt: number;
    factsWritten?: number;
    reason?: string;
  }): void => {
    const tookMs = Math.max(0, now() - context.startedAt);
    deps.metrics?.recordReflection({
      sessionId: context.sessionId,
      outcome,
      durationMs: tookMs,
    });
    const logContext = {
      sessionId: context.sessionId,
      tookMs,
      ...(typeof context.factsWritten === "number"
        ? { factsWritten: context.factsWritten }
        : {}),
      ...(context.reason ? { reason: context.reason } : {}),
    };
    switch (outcome) {
      case "ok":
        deps.logger?.info("reflection.ok", logContext);
        return;
      case "none":
        deps.logger?.debug("reflection.none", logContext);
        return;
      case "aborted":
        deps.logger?.debug("reflection.aborted", logContext);
        return;
      case "timeout":
        deps.logger?.warn("reflection.timeout", logContext);
        return;
      case "failed":
        deps.logger?.warn("reflection.failed", logContext);
        return;
    }
  };

  const runOne = async (input: ReflectionInput): Promise<void> => {
    if (pending) {
      pending.abort();
    }
    const controller = new AbortController();
    pending = controller;
    const startedAt = now();
    deps.logger?.debug("reflection.fired", { sessionId: input.sessionId });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deps.timeoutMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref?: () => void }).unref?.();
    }

    try {
      const prompt = buildReflectionPrompt({
        userMessage: input.userMessage,
        assistantReply: input.assistantReply,
      });
      const completion = await deps.llmComplete({
        prompt,
        grammar: REFLECTION_GRAMMAR,
        slotId: deps.reflectionSlotId,
        sessionId: `reflection:${input.sessionId}`,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        finish(timedOut ? "timeout" : "aborted", {
          sessionId: input.sessionId,
          startedAt,
        });
        return;
      }
      const parsed = parseReflectionOutput(completion.content);
      if (parsed.kind === "none") {
        finish("none", { sessionId: input.sessionId, startedAt });
        return;
      }
      const clamped = parsed.facts.slice(0, deps.maxFactsPerCall);
      let written = 0;
      for (const fact of clamped) {
        try {
          deps.profileStore.set(fact.key, fact.value);
          written += 1;
        } catch (err) {
          if (err instanceof ProfileValidationError) {
            deps.logger?.debug("reflection.invalid_fact", {
              sessionId: input.sessionId,
              key: fact.key,
              reason: err.message,
            });
            continue;
          }
          throw err;
        }
      }
      if (written === 0) {
        finish("none", { sessionId: input.sessionId, startedAt });
        return;
      }
      finish("ok", {
        sessionId: input.sessionId,
        startedAt,
        factsWritten: written,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        finish(timedOut ? "timeout" : "aborted", {
          sessionId: input.sessionId,
          startedAt,
        });
        return;
      }
      const reason = err instanceof Error ? err.message : String(err);
      finish("failed", { sessionId: input.sessionId, startedAt, reason });
    } finally {
      clearTimeout(timer);
      if (pending === controller) {
        pending = null;
      }
    }
  };

  return {
    async reflect(input) {
      try {
        await runOne(input);
      } catch (err) {
        // Defence in depth: `runOne` already swallows its own errors,
        // but if something slips through we never want to bubble it
        // into the agent loop's fire-and-forget caller.
        const reason = err instanceof Error ? err.message : String(err);
        deps.logger?.warn("reflection.failed", {
          sessionId: input.sessionId,
          tookMs: 0,
          reason,
        });
      }
    },
    abortPending() {
      if (pending) {
        pending.abort();
      }
    },
  };
}
