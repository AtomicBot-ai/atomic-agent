import type { AgentMetrics } from "../../tracing/agent-metrics.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import {
  MemoryStore,
  MemoryValidationError,
  type EvolveTagsResult,
} from "../memory-store.js";
import type { ReflectionEvolve } from "../reflection/reflection-parser.js";

/**
 * Memory-v2 phase 3 (Path B-half-2). Pure post-parser writer that
 * turns `EVOLVE` directives extracted by the reflection parser into
 * metadata-only mutations on existing memory rows.
 *
 * Architectural contract:
 *
 *  - **`content` is never written.** The runner does not even accept
 *    a content delta — the `MemoryStore.evolveTags` signature
 *    enforces it at the store level too. This is cross-phase
 *    invariant 5 in MEMORY_FABRIC_V2.md §13.7.7 (content stays
 *    append-only under N evolve calls).
 *  - **B↔C lease is honoured.** When a target's `consolidating_at`
 *    is set within the configured lease window, the call is skipped
 *    and counted under `agent.memory.evolution.skipped{reason="lease_held"}`.
 *    The phase-5 consolidator is the only writer of the lease (yet);
 *    the evolver reads it through `MemoryStore.evolveTags`.
 *  - **Per-write cap.** `maxPerWrite` (default 2) bounds the number
 *    of EVOLVE entries actually applied per call. Excess directives
 *    are dropped with reason `cap_hit` and counted separately so
 *    dashboards can spot pathological completions.
 *  - **Allowlist (optional).** When `allowlist` is provided, only
 *    EVOLVE directives whose `targetId` is in the set are considered.
 *    This is the recall-side anti-feedback-loop guard, mirroring the
 *    surfaced-id allowlist used by the link-generator (phase 2). The
 *    runner accepts `allowlist === undefined` for back-compat with
 *    callers that have no per-turn surfaced set.
 *  - **Fire-safe.** Throws nothing. Validation errors and missing
 *    targets are folded into structured `skipped_*` outcomes; the
 *    caller never has to wrap.
 *
 * The evolver is **not** an LLM-calling runner like
 * `LinkGeneratorRunner` — the LLM round-trip that produced the
 * EVOLVE lines already happened inside the main reflection pass.
 * Sequencing inside `ReflectionRunner.runOne`:
 *   extract (SET/NOTE/EVOLVE) → write SET → write NOTE →
 *   link-generator (phase 2) → **neighbor-evolver (phase 3)**.
 * No new LLM cost per turn for this phase.
 */
export interface NeighborEvolverDeps {
  memoryStore: MemoryStore;
  /** Hard cap on number of EVOLVE entries applied per call. Default 2. */
  maxPerWrite?: number;
  /** B↔C lease window in ms. Default 60_000. */
  leaseMs?: number;
  logger?: StructuredLogger;
  metrics?: AgentMetrics;
  /** Injectable clock for tests. */
  now?: () => number;
}

export type NeighborEvolveOutcome =
  | "applied"
  | "skipped_lease_held"
  | "skipped_no_change"
  | "skipped_not_in_allowlist"
  | "skipped_cap_hit"
  | "skipped_missing"
  | "skipped_invalid";

export interface NeighborEvolveReport {
  sessionId: string;
  applied: number;
  skipped: Partial<Record<NeighborEvolveOutcome, number>>;
  totalProposed: number;
}

export interface NeighborEvolveInput {
  sessionId: string;
  evolves: readonly ReflectionEvolve[];
  /** Surfaced ids for this turn — the anti-feedback allowlist. */
  allowlist?: ReadonlySet<number>;
}

export class NeighborEvolver {
  private readonly memoryStore: MemoryStore;
  private readonly maxPerWrite: number;
  private readonly leaseMs: number;
  private readonly logger: StructuredLogger | undefined;
  private readonly metrics: AgentMetrics | undefined;
  private readonly now: () => number;

  constructor(deps: NeighborEvolverDeps) {
    this.memoryStore = deps.memoryStore;
    this.maxPerWrite = Math.max(0, Math.floor(deps.maxPerWrite ?? 2));
    this.leaseMs = Math.max(0, Math.floor(deps.leaseMs ?? 60_000));
    this.logger = deps.logger;
    this.metrics = deps.metrics;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Apply the parsed EVOLVE directives to the store. Returns a
   * structured report — callers can ignore it; the metrics path
   * already records every outcome.
   */
  apply(input: NeighborEvolveInput): NeighborEvolveReport {
    const report: NeighborEvolveReport = {
      sessionId: input.sessionId,
      applied: 0,
      skipped: {},
      totalProposed: input.evolves.length,
    };

    const bump = (outcome: NeighborEvolveOutcome): void => {
      if (outcome === "applied") return;
      report.skipped[outcome] = (report.skipped[outcome] ?? 0) + 1;
    };

    const recordMetric = (outcome: NeighborEvolveOutcome): void => {
      this.metrics?.recordMemoryEvolution({
        sessionId: input.sessionId,
        outcome,
      });
    };

    if (input.evolves.length === 0 || this.maxPerWrite === 0) {
      return report;
    }

    const now = this.now();
    let applied = 0;

    for (const directive of input.evolves) {
      if (applied >= this.maxPerWrite) {
        bump("skipped_cap_hit");
        recordMetric("skipped_cap_hit");
        this.logger?.debug("memory_evolution.skipped", {
          sessionId: input.sessionId,
          reason: "cap_hit",
          targetId: directive.targetId,
        });
        continue;
      }
      if (input.allowlist && !input.allowlist.has(directive.targetId)) {
        bump("skipped_not_in_allowlist");
        recordMetric("skipped_not_in_allowlist");
        this.logger?.debug("memory_evolution.skipped", {
          sessionId: input.sessionId,
          reason: "not_in_allowlist",
          targetId: directive.targetId,
        });
        continue;
      }
      const outcome = this.applyOne(directive, now);
      bump(outcome);
      recordMetric(outcome);
      if (outcome === "applied") {
        applied += 1;
        report.applied += 1;
      }
    }

    return report;
  }

  private applyOne(
    directive: ReflectionEvolve,
    now: number,
  ): NeighborEvolveOutcome {
    let result: EvolveTagsResult;
    try {
      result = this.memoryStore.evolveTags(
        directive.targetId,
        directive.addTags,
        { leaseMs: this.leaseMs, now },
      );
    } catch (err) {
      if (err instanceof MemoryValidationError) {
        return "skipped_invalid";
      }
      throw err;
    }
    switch (result.outcome) {
      case "applied":
        this.logger?.info("memory_evolved", {
          targetId: directive.targetId,
          fieldsChanged: ["tags"],
          addedTags: result.added,
        });
        return "applied";
      case "skipped_lease_held":
        this.logger?.debug("memory_evolution.skipped", {
          reason: "lease_held",
          targetId: directive.targetId,
        });
        return "skipped_lease_held";
      case "skipped_no_change":
        return "skipped_no_change";
      case "missing":
        return "skipped_missing";
    }
  }
}
