import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { AgentMetrics } from "../../tracing/agent-metrics.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

import { LINK_GENERATOR_GRAMMAR } from "./link-generator-grammar.js";
import {
  buildLinkGeneratorPrompt,
  type LinkGeneratorPromptInput,
} from "./link-generator-prompt.js";
import {
  parseLinkGeneratorOutput,
  type ParsedLink,
} from "./link-generator-parser.js";
import { LinkStore, LinkValidationError } from "./link-store.js";

/**
 * Memory-v2 phase 2. Fire-and-forget runner that turns a recent
 * macro-turn + a set of surfaced memory ids into LINK edges via a
 * dedicated LLM sub-call on the reflection slot (cross-phase
 * invariant 2 in [src/memory/reflection/reflection-runner.ts]).
 *
 * Architectural notes:
 *   - Separate from `ReflectionRunner` because it consumes its own
 *     prompt + grammar and writes to a different table
 *     (`memory_links`). Keeping the runners separate also keeps the
 *     parser blast radius small — a regression in the link parser
 *     can never break the fact / note extraction path.
 *   - Always rides the **same** `reflectionSlotId` so the main
 *     agent slot's KV cache stays warm. The slot semantics are
 *     identical to the reflection runner — see `reflection-runner.ts`
 *     doc-comment for the cross-session-FIFO contract.
 *   - Per-session in-flight map mirrors `ReflectionRunner.pending`
 *     so a session-B link-gen can never abort a session-A one.
 *   - Fire-safe by design: `generate()` never throws; failures are
 *     logged + counted into `agent.memory.link_generator.*`.
 *   - Anti-feedback-loop: the parser drops links whose endpoints
 *     are outside the caller-supplied `allowlist` (the surfaced
 *     memory ids for the turn). Without this guard a runaway model
 *     could create edges between arbitrary ids and pollute the
 *     graph permanently.
 */
export interface LinkGeneratorInput {
  sessionId: string;
  userMessage: string;
  assistantReply: string;
  candidates: LinkGeneratorPromptInput["candidates"];
}

export type LinkGeneratorOutcome =
  | "ok"
  | "none"
  | "skipped"
  | "aborted"
  | "timeout"
  | "failed";

export interface LinkGeneratorRunner {
  /**
   * Fire-safe. Never throws. Returns the count of persisted links
   * (zero on `none` / `skipped` / failure paths) primarily for
   * tests — the agent loop never inspects the result.
   */
  generate(input: LinkGeneratorInput): Promise<number>;
  /**
   * Cancels in-flight link-gen calls. Same per-session semantics as
   * `ReflectionRunner.abortPending`.
   */
  abortPending(options?: { sessionId?: string }): void;
}

export type LinkGeneratorLlmComplete = (params: {
  prompt: string;
  grammar: string;
  slotId: number;
  sessionId: string;
  signal: AbortSignal;
}) => Promise<CompletionResult>;

export interface LinkGeneratorRunnerDeps {
  llmComplete: LinkGeneratorLlmComplete;
  linkStore: LinkStore;
  /** Same slot as reflection — invariant 2. */
  reflectionSlotId: number;
  /** Hard timeout per generation call. */
  timeoutMs: number;
  /** Upper bound on persisted links per call. Default 4. */
  maxLinksPerCall?: number;
  /** Minimum candidate count below which we skip the LLM call entirely. */
  minCandidates?: number;
  logger?: StructuredLogger;
  metrics?: AgentMetrics;
  /** Injectable clock for tests. */
  now?: () => number;
}

export function createLinkGeneratorRunner(
  deps: LinkGeneratorRunnerDeps,
): LinkGeneratorRunner {
  const now = deps.now ?? Date.now;
  const pending = new Map<string, AbortController>();
  const maxLinksPerCall = deps.maxLinksPerCall ?? 4;
  const minCandidates = deps.minCandidates ?? 2;

  const finish = (
    outcome: LinkGeneratorOutcome,
    context: {
      sessionId: string;
      startedAt: number;
      linksWritten?: number;
      reason?: string;
    },
  ): void => {
    const tookMs = Math.max(0, now() - context.startedAt);
    deps.metrics?.recordLinkGenerator({
      sessionId: context.sessionId,
      outcome,
      durationMs: tookMs,
      ...(typeof context.linksWritten === "number"
        ? { linksWritten: context.linksWritten }
        : {}),
    });
    const logContext = {
      sessionId: context.sessionId,
      tookMs,
      ...(typeof context.linksWritten === "number"
        ? { linksWritten: context.linksWritten }
        : {}),
      ...(context.reason ? { reason: context.reason } : {}),
    };
    switch (outcome) {
      case "ok":
        deps.logger?.info("link_generator.ok", logContext);
        return;
      case "none":
        deps.logger?.debug("link_generator.none", logContext);
        return;
      case "skipped":
        deps.logger?.debug("link_generator.skipped", logContext);
        return;
      case "aborted":
        deps.logger?.debug("link_generator.aborted", logContext);
        return;
      case "timeout":
        deps.logger?.warn("link_generator.timeout", logContext);
        return;
      case "failed":
        deps.logger?.warn("link_generator.failed", logContext);
        return;
    }
  };

  const runOne = async (input: LinkGeneratorInput): Promise<number> => {
    if (input.candidates.length < minCandidates) {
      finish("skipped", { sessionId: input.sessionId, startedAt: now() });
      return 0;
    }
    const previous = pending.get(input.sessionId);
    if (previous) previous.abort();
    const controller = new AbortController();
    pending.set(input.sessionId, controller);
    const startedAt = now();
    deps.logger?.debug("link_generator.fired", {
      sessionId: input.sessionId,
      candidates: input.candidates.length,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deps.timeoutMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref?: () => void }).unref?.();
    }

    try {
      const prompt = buildLinkGeneratorPrompt({
        userMessage: input.userMessage,
        assistantReply: input.assistantReply,
        candidates: input.candidates,
      });
      const completion = await deps.llmComplete({
        prompt,
        grammar: LINK_GENERATOR_GRAMMAR,
        slotId: deps.reflectionSlotId,
        sessionId: `link-gen:${input.sessionId}`,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        finish(timedOut ? "timeout" : "aborted", {
          sessionId: input.sessionId,
          startedAt,
        });
        return 0;
      }
      const allowlist = new Set(input.candidates.map((c) => c.id));
      const parsed = parseLinkGeneratorOutput(completion.content, {
        allowlist,
        maxLinks: maxLinksPerCall,
      });
      if (parsed.kind === "none") {
        finish("none", { sessionId: input.sessionId, startedAt });
        return 0;
      }
      const linksWritten = writeLinks(
        parsed.links,
        deps.linkStore,
        input.sessionId,
        deps.logger,
      );
      if (linksWritten === 0) {
        finish("none", { sessionId: input.sessionId, startedAt });
        return 0;
      }
      finish("ok", {
        sessionId: input.sessionId,
        startedAt,
        linksWritten,
      });
      return linksWritten;
    } catch (err) {
      if (controller.signal.aborted) {
        finish(timedOut ? "timeout" : "aborted", {
          sessionId: input.sessionId,
          startedAt,
        });
        return 0;
      }
      const reason = err instanceof Error ? err.message : String(err);
      finish("failed", { sessionId: input.sessionId, startedAt, reason });
      return 0;
    } finally {
      clearTimeout(timer);
      if (pending.get(input.sessionId) === controller) {
        pending.delete(input.sessionId);
      }
    }
  };

  return {
    async generate(input) {
      try {
        return await runOne(input);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        deps.logger?.warn("link_generator.failed", {
          sessionId: input.sessionId,
          tookMs: 0,
          reason,
        });
        return 0;
      }
    },
    abortPending(options) {
      if (options?.sessionId !== undefined) {
        const target = pending.get(options.sessionId);
        if (target) target.abort();
        return;
      }
      for (const controller of pending.values()) controller.abort();
    },
  };
}

function writeLinks(
  links: readonly ParsedLink[],
  store: LinkStore,
  sessionId: string,
  logger: StructuredLogger | undefined,
): number {
  let written = 0;
  for (const link of links) {
    try {
      store.add({
        fromId: link.fromId,
        toId: link.toId,
        kind: link.kind,
      });
      written += 1;
    } catch (err) {
      if (err instanceof LinkValidationError) {
        logger?.debug("link_generator.invalid_link", {
          sessionId,
          field: err.field,
          reason: err.message,
        });
        continue;
      }
      throw err;
    }
  }
  return written;
}
