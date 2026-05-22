import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { AgentMetrics } from "../../tracing/agent-metrics.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

import type { NeighborEvolver } from "../evolution/neighbor-evolver.js";
import { MemoryStore, MemoryValidationError } from "../memory-store.js";
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
  /**
   * Memory-v2 phase 2. Ids surfaced into the `### recalled` section
   * for this turn (BM25/cosine hits plus any link-graph expansion).
   * Used as the allowlist for the `link-generator` sub-call so the
   * graph can never accumulate edges between memories the LLM never
   * saw. Optional — when omitted, the link-generator skips this
   * turn entirely.
   */
  recalledMemoryIds?: readonly number[];
  /**
   * Memory-v2 phase 7a. Ids of lessons that actually rendered into
   * the `### lessons` section for this turn. Threaded into the
   * vote-runner allowlist (cross-phase invariant 18) so the model
   * can never vote on a lesson it did not see in context.
   */
  recalledLessonIds?: readonly number[];
  /**
   * Memory-v2 phase 7a. Ids of profile_facts that actually rendered
   * into the `### profile` section for this turn. Threaded into the
   * vote-runner allowlist so the LLM can only vote on facts that
   * were visible (pinned facts plus contextually-gated ones that
   * passed the keyword filter).
   */
  recalledProfileFactIds?: readonly number[];
  /**
   * Memory-v2 phase 7b. Ids of procedures rendered into the
   * `### procedures` section for this turn. Threaded into the
   * vote-runner allowlist so the model can only vote on
   * procedures it actually saw.
   */
  recalledProcedureIds?: readonly number[];
  /**
   * Memory-v2 phase 7a. 0-based turn index within the session,
   * propagated into `vote_events.turn_index` for audit attribution.
   * Optional — when missing, the audit row stores `NULL`.
   */
  turnIndex?: number;
  /**
   * v2.5 (Phase B — config v18). Multi-turn
   * transcript window. When present, the reflection prompt renders
   * the entire array as numbered USER/ASSISTANT exchanges (instead
   * of the single `userMessage` + `assistantReply` pair). The runner
   * still extracts facts/notes across the whole window — sliding-
   * window segmentation lets long sessions amortise reflection cost
   * (fire every N turns over the last W pairs) without losing
   * cross-turn signal.
   *
   * When omitted, the runner falls back to the legacy single-pair
   * prompt so callers that never opt into segmentation stay
   * byte-stable. The trailing pair in `transcript[]` MUST mirror
   * `userMessage` / `assistantReply` (or be a strict superset) —
   * the runner trusts the agent loop to project consistently.
   */
  transcript?: readonly { user: string; assistant: string }[];
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
  /**
   * Cancels in-flight reflections. When `options.sessionId` is
   * provided, only the matching session's reflection is aborted —
   * other sessions' reflections continue undisturbed. With no
   * argument, every pending reflection across every session is
   * aborted (used at runtime shutdown).
   */
  abortPending(options?: { sessionId?: string }): void;
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
   * Freeform `MemoryStore`. When provided together with a non-zero
   * `maxNotesPerCall`, reflection also mirrors extracted `NOTE` lines
   * into durable notes. Leave undefined to keep the legacy
   * profile-only behaviour (reflection will still honour `SET` lines).
   */
  memoryStore?: MemoryStore;
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
  /**
   * Upper bound on freeform notes written per reflection call. `0`
   * disables note extraction even when `memoryStore` is provided. The
   * bound is enforced after parser-side clamping so the runner never
   * floods `MemoryStore` on a pathological completion.
   */
  maxNotesPerCall?: number;
  /**
   * Memory-v2 phase 3. When provided, parsed `EVOLVE` directives are
   * applied via this evolver after notes are stored. The evolver
   * receives `input.recalledMemoryIds` as the allowlist so the
   * surfaced set gates every metadata mutation. Leave undefined to
   * disable EVOLVE handling entirely (parser still extracts the
   * directives but the runner drops them silently).
   */
  neighborEvolver?: NeighborEvolver;
  /**
   * v2.5 typed-NOTE extraction. When `true`, the runner
   * picks `REFLECTION_STABLE_PREFIX_TYPED` and tells the model to
   * prefix every NOTE body with `[type=event|behavior|knowledge|skill]`.
   * The parser projects the marker into a synthetic `type:X` tag on
   * the stored MemoryEntry without changing the schema. Default
   * `false` — preserves byte-stable behaviour for callers that have
   * never touched typed mode.
   */
  typedNotes?: boolean;
  /**
   * Multi-party / "any-speaker" reflection mode (config v19+).
   * When `true`, the runner picks
   * `REFLECTION_STABLE_PREFIX_ANY_SPEAKER` so the extractor
   * treats every named speaker in the USER channel — including
   * third parties — as a valid source for SET / NOTE extraction.
   * Wins over `typedNotes` (the any-speaker prefix already
   * enforces typed NOTEs). Default `false`.
   */
  anySpeaker?: boolean;
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
 *  - At most one reflection is in flight per `sessionId`. A new
 *    `reflect({ sessionId, … })` call aborts only the previous
 *    reflection on that *same* session — reflections on other
 *    sessions continue undisturbed. This is the load-bearing
 *    invariant for cross-session parallelism: under Option 6's
 *    `TurnController`, two sessions can finish their turns at the
 *    same time and each fire reflection without trampling the
 *    other.
 *  - `abortPending()` cancels every in-flight reflection (used at
 *    runtime shutdown). `abortPending({ sessionId })` cancels only
 *    the matching session — used by `agent-loop.runTurn` at the
 *    start of every turn so a stale reflection from the previous
 *    same-session turn cannot race the next one.
 *
 * TODO(memory-v2): cross-phase invariant 2 — every new reflection
 * sub-call (phase 2 `link-generator`, phase 3 `neighbor-evolver`,
 * phase 7a `vote-runner`) must ride the same `reflectionSlotId` reserved
 * here via `slotManager.reserveReflectionSlot()`. The main agent slot's
 * KV cache must stay untouched. Sub-calls share the same `timeoutMs`
 * budget; the runner runs them sequentially as
 *   extract → for each NOTE { store → link-generator → for each link
 *   { neighbor-evolver.tryEvolve } } → vote-runner.
 * See [MEMORY_FABRIC_V2.md](../../../MEMORY_FABRIC_V2.md) §6.2 / §6.4.
 */
export function createReflectionRunner(
  deps: ReflectionRunnerDeps,
): ReflectionRunner {
  const now = deps.now ?? Date.now;

  /**
   * In-flight reflection per session. Keyed by `ReflectionInput.sessionId`
   * so a `reflect()` on session B can never abort a reflection on
   * session A. Entries are removed when the corresponding `runOne`
   * settles.
   */
  const pending = new Map<string, AbortController>();

  const finish = (outcome: ReflectionOutcome, context: {
    sessionId: string;
    startedAt: number;
    factsWritten?: number;
    notesWritten?: number;
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
      ...(typeof context.notesWritten === "number"
        ? { notesWritten: context.notesWritten }
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
    const previous = pending.get(input.sessionId);
    if (previous) {
      previous.abort();
    }
    const controller = new AbortController();
    pending.set(input.sessionId, controller);
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
        ...(deps.typedNotes ? { typedNotes: true } : {}),
        ...(deps.anySpeaker ? { anySpeaker: true } : {}),
        // v2.5 (Phase B). When the agent loop
        // hands a multi-turn transcript window, the prompt renders
        // it instead of the single trailing pair.
        ...(input.transcript && input.transcript.length > 0
          ? { transcript: input.transcript }
          : {}),
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
      const factsWritten = writeFacts(
        parsed.facts,
        deps.profileStore,
        deps.maxFactsPerCall,
        input.sessionId,
        deps.logger,
      );
      const notesWritten = writeNotes(
        parsed.notes,
        deps.memoryStore,
        deps.maxNotesPerCall ?? 0,
        input.sessionId,
        deps.logger,
      );

      // Memory-v2 phase 3. Apply EVOLVE directives last. The evolver
      // is fire-safe and the allowlist (surfaced ids for this turn)
      // gates every write so a runaway completion can't pollute the
      // store with mutations on memories the LLM never saw.
      const evolvesApplied = applyEvolves(
        parsed.evolves,
        deps.neighborEvolver,
        input,
      );
      if (
        factsWritten === 0 &&
        notesWritten === 0 &&
        evolvesApplied === 0
      ) {
        finish("none", { sessionId: input.sessionId, startedAt });
        return;
      }
      finish("ok", {
        sessionId: input.sessionId,
        startedAt,
        factsWritten,
        notesWritten,
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
      if (pending.get(input.sessionId) === controller) {
        pending.delete(input.sessionId);
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
    abortPending(options) {
      if (options?.sessionId !== undefined) {
        const target = pending.get(options.sessionId);
        if (target) target.abort();
        return;
      }
      for (const controller of pending.values()) {
        controller.abort();
      }
    },
  };
}

/**
 * Upsert parsed SET facts into `ProfileStore`, skipping individual
 * validation errors so one bad key does not invalidate the rest of the
 * batch. Returns the number of facts successfully written.
 */
function writeFacts(
  facts: readonly {
    key: string;
    value: string;
    pinned: boolean;
    keywords: readonly string[];
    /**
     * Memory-v2 phase 4. Optional cross-key supersession hint. The
     * parser drops malformed values; the store handles `null` /
     * missing fields gracefully (auto-chains same-key writes).
     */
    supersedes?: string | null;
  }[],
  store: ProfileStore,
  maxPerCall: number,
  sessionId: string,
  logger: StructuredLogger | undefined,
): number {
  const clamped = facts.slice(0, maxPerCall);
  let written = 0;
  for (const fact of clamped) {
    try {
      const opts: Parameters<ProfileStore["set"]>[2] = {
        pinned: fact.pinned,
        keywords: [...fact.keywords],
      };
      if (typeof fact.supersedes === "string" && fact.supersedes.length > 0) {
        (opts as { supersedesKey?: string }).supersedesKey = fact.supersedes;
      }
      store.set(fact.key, fact.value, opts);
      written += 1;
    } catch (err) {
      if (err instanceof ProfileValidationError) {
        logger?.debug("reflection.invalid_fact", {
          sessionId,
          key: fact.key,
          reason: err.message,
        });
        continue;
      }
      throw err;
    }
  }
  return written;
}

/**
 * Persist parsed NOTE bodies as freeform memories. No-op when the
 * runner was constructed without a `memoryStore` or when
 * `maxNotesPerCall` is 0. Reflection-sourced notes carry a synthetic
 * `reflection` tag in addition to any tags the parser extracted, so
 * downstream recall can tell them apart from agent-initiated
 * `memory.notes.store` calls. Validation errors (content too long /
 * empty after trim) are logged and skipped, matching fact-side
 * semantics.
 */
function writeNotes(
  notes: readonly { body: string; tags: string[] }[],
  store: MemoryStore | undefined,
  maxPerCall: number,
  sessionId: string,
  logger: StructuredLogger | undefined,
): number {
  if (!store || maxPerCall <= 0 || notes.length === 0) return 0;
  const clamped = notes.slice(0, maxPerCall);
  let written = 0;
  for (const note of clamped) {
    try {
      const tags = dedupeTags(["reflection", ...note.tags]);
      store.store({
        content: note.body,
        tags,
        sessionId,
        source: "agent",
      });
      written += 1;
    } catch (err) {
      if (err instanceof MemoryValidationError) {
        logger?.debug("reflection.invalid_note", {
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

function dedupeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    if (tag.length === 0) continue;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * Memory-v2 phase 3. Apply parsed EVOLVE directives via the
 * `NeighborEvolver`. Returns the count of directives that actually
 * landed (`applied` outcome). Skips entirely when no evolver was
 * wired or the parser produced no directives.
 */
function applyEvolves(
  evolves: readonly import("./reflection-parser.js").ReflectionEvolve[],
  evolver: NeighborEvolver | undefined,
  input: ReflectionInput,
): number {
  if (!evolver || evolves.length === 0) return 0;
  const allowlist =
    input.recalledMemoryIds && input.recalledMemoryIds.length > 0
      ? new Set(input.recalledMemoryIds)
      : undefined;
  const report = evolver.apply({
    sessionId: input.sessionId,
    evolves,
    ...(allowlist ? { allowlist } : {}),
  });
  return report.applied;
}
