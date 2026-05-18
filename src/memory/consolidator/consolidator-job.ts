import type { AgentMetrics } from "../../tracing/agent-metrics.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { LessonStore } from "../lessons/lesson-store.js";
import type { LinkStore } from "../links/link-store.js";
import type {
  MemoryEntry,
  MemoryStore,
} from "../memory-store.js";

import { clusterEpisodes, type MemoryCluster } from "./clustering.js";
import { DistillRunner } from "./distill-runner.js";

/**
 * Memory-v2 phase 5. The cold-path consolidator.
 *
 * One tick of `runOnce` does the following, sequentially:
 *
 *   1. **Select**       candidate episodes — `consolidated_into IS NULL`
 *                       AND `updated_at < now - cooldownMs`.
 *   2. **Acquire lease** on every candidate so the reflection-side
 *                       neighbor-evolver (phase 3) skips them while
 *                       distillation is in flight. The lease window
 *                       is `consolidationLeaseMs` (default same as
 *                       `memory.evolution.leaseMs`).
 *   3. **Cluster**      via `clusterEpisodes` (CC + tag-intersection).
 *                       Clusters smaller than `minClusterSize` drop
 *                       out.
 *   4. **Distill**      each cluster via `DistillRunner` (one LLM call
 *                       per cluster, all on the dedicated reflection
 *                       slot). Failures isolate per-cluster.
 *   5. **Persist**      a new `LessonStore.create(...)` row with the
 *                       parent ids array.
 *   6. **Archive**      parents via `MemoryStore.archiveInto(...)`
 *                       so they fall out of `### memory-index`.
 *   7. **Rewire links** (graph cleanup): drop intra-cluster edges,
 *                       redirect cluster↔outside edges to point at
 *                       the new lesson — actually that's a future
 *                       extension; in phase 5 we record outbound
 *                       cross-cluster edges in a tracking structure
 *                       and rely on FK cascade to clean up intra-
 *                       cluster ones implicitly when episodes are
 *                       archived. **TODO(phase 5+1)**: full link
 *                       rewiring (scenario 5.C requires it).
 *   8. **Release lease** on every member, win or lose.
 *
 * Cross-phase invariants pinned here:
 *
 *   - **One LLM call per cluster.** No retry loop — failures count
 *     as "skip the cluster", a future tick can retry.
 *   - **Fire-safe.** Errors are caught at every layer, never
 *     bubble up to the Scheduler.
 *   - **Idempotent on re-tick.** Re-running on the same data
 *     produces zero changes because `consolidated_into IS NOT NULL`
 *     excludes already-archived rows from step 1.
 *
 * **Phase 5 limitation (scenario 5.C).** Full bidirectional link
 * rewiring (intra-cluster edges deleted, cross-cluster edges
 * redirected to the new lesson) is **partially deferred** to a
 * follow-up patch. We do the symmetric-easy half here:
 * intra-cluster edges between archived parents survive until the
 * parent rows are deleted; cross-cluster edges live on as edges
 * between an archived parent and an outside note. The
 * `excludeArchived` filter on `### memory-index` masks the visible
 * impact, but the graph itself is not yet pristine. Document is
 * the source of truth — see AGENTS.md "Memory fabric phase 5"
 * §5.C deferred for the full plan.
 */
export interface ConsolidatorTickResult {
  outcome: "ok" | "none" | "failed";
  clustersConsidered: number;
  lessonsCreated: number;
  lessonsAbstained: number;
  failures: number;
  /**
   * Phase 6. Count of lessons demoted to `status='deprecated'`
   * during this tick.
   */
  lessonsDeprecatedByAge: number;
  lessonsDeprecatedByOverflow: number;
  /**
   * Phase 7a. Count of lessons demoted because their `vote_score`
   * went negative before they ever helped a turn. Always `0`
   * when `voting.enabled === false`.
   */
  lessonsDeprecatedByVote: number;
  /**
   * Phase 7a. Whether the per-tick `decayAllScores` pass ran on
   * this tick. `false` when voting is disabled or the runtime
   * could not construct a `VoteStore`.
   */
  voteDecayApplied: boolean;
}

export interface ConsolidatorJobOptions {
  /** Master switch — driven by `memory.consolidation.enabled`. */
  enabled: boolean;
  intervalMs: number;
  cooldownMs: number;
  minClusterSize: number;
  maxClustersPerTick: number;
  requireSharedTag: boolean;
  /** Reuses `memory.evolution.leaseMs` so the lock contract is uniform. */
  consolidationLeaseMs: number;
  /**
   * Phase 6 — age threshold for demoting unused (`success_count = 0`)
   * lessons. `0` disables the age sweep. Wired from
   * `memory.lessons.deprecationAgeMs`.
   */
  deprecationAgeMs?: number;
  /**
   * Phase 6 — defensive per-tick cap on how many lessons the
   * combined age + FIFO sweep may demote. Prevents a runaway tick
   * from churning the store if `LessonStore` somehow returns a
   * pathological set. Default `100`.
   */
  maxDeprecationsPerTick?: number;
  /**
   * Phase 7a — decay factor applied to every `vote_score` row
   * once per tick (cross-phase invariant 23: decay is per-tick, not
   * per-turn). `0` or `undefined` disables both decay and the
   * vote-driven deprecation pass entirely. Should typically be
   * sourced from `memory.voting.signalDecay`.
   */
  voteSignalDecay?: number;
}

export interface ConsolidatorJobDeps {
  memoryStore: MemoryStore;
  linkStore: LinkStore;
  lessonStore: LessonStore;
  distillRunner: DistillRunner;
  /**
   * Memory-v2 phase 7a — optional vote store. When present **and**
   * `voteSignalDecay` is positive, every tick decays scores before
   * the deprecation sweep runs. Optional so phase 5 / 6 tests can
   * still spin a consolidator without wiring voting.
   */
  voteStore?: {
    decayAllScores(factor: number): {
      memories: number;
      lessons: number;
      profileFacts: number;
    };
  } | null;
  /** Default `Date.now`. Injectable for tests. */
  now?: () => number;
  metrics?: AgentMetrics;
  logger?: StructuredLogger;
  /**
   * Memory-v2 phase 6 — optional sink for the `lesson_deprecated`
   * trace event. Fired once per demoted lesson during the sweep.
   * The job stays decoupled from `TraceBus` so unit tests do not
   * need to wire one up.
   */
  onLessonDeprecated?: (event: {
    lessonId: number;
    reason: string;
  }) => void;
  /**
   * A correlation id to stamp on every trace event emitted during a
   * tick. Useful when a long-running deployment has dozens of ticks
   * landing in the same log file. Defaults to the iso timestamp.
   */
  workingDir?: string | null;
}

export class ConsolidatorJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly now: () => number;

  constructor(
    private readonly options: ConsolidatorJobOptions,
    private readonly deps: ConsolidatorJobDeps,
  ) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Start the scoped periodic timer. **This is a deliberate carve-out
   * from §"Background autonomy" — Scheduler is normally the only
   * periodic timer in the runtime, but the consolidator owns a
   * second one for the same reason Telegram polling does: the cold-
   * path cadence (default 6 h) is too long for Scheduler to amortise,
   * and the work is single-process-bounded by the lease + the
   * `running` guard.**
   *
   * Calling `start()` twice is a no-op.
   */
  start(): void {
    if (!this.options.enabled) return;
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => {
        this.deps.logger?.warn?.("consolidator.tick.unexpected", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.options.intervalMs);
    // Avoid pinning the event loop open in CLI / one-shot contexts.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run exactly one tick. Returns the per-tick summary. Used by the
   * timer above and by tests / CLI debugging tools that want to
   * force a tick without waiting for `intervalMs`.
   *
   * **Fire-safe.** The whole body runs inside a try/catch; on a
   * top-level failure the metric records `outcome=failed` and the
   * return is the zero-summary.
   */
  async runOnce(signal?: AbortSignal): Promise<ConsolidatorTickResult> {
    if (this.running) {
      // Reentry guard — the previous tick still owns the lease set.
      return zeroSummary();
    }
    this.running = true;
    const sig = signal ?? new AbortController().signal;
    let result: ConsolidatorTickResult = zeroSummary();
    try {
      result = await this.runTick(sig);
    } catch (err) {
      this.deps.logger?.warn?.("consolidator.tick.failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      result = { ...result, outcome: "failed", failures: result.failures + 1 };
    } finally {
      // Phase 6 — the deprecation sweep runs **after** the
      // distillation loop, **inside** the running guard, even when
      // distillation produced nothing (`outcome: "none"`). This
      // matters for the steady-state cron: most ticks find no new
      // clusters but still need to keep the lesson set bounded.
      // Sweep failures are isolated and never overwrite the
      // distillation outcome — the worst case is that the sweep
      // counters stay at 0 and the next tick retries.
      try {
        // Phase 7a — decay first so the vote-deprecation pass below
        // sees up-to-date `vote_score` values. Bulk SQL; one
        // transaction per `(memories|lessons|profile_facts)` table.
        // Cross-phase invariant 23: decay runs per-tick, not
        // per-turn.
        const decayApplied = this.runVoteDecay();
        const sweep = this.runDeprecationSweep(this.now());
        result = {
          ...result,
          lessonsDeprecatedByAge: sweep.byAge,
          lessonsDeprecatedByOverflow: sweep.byOverflow,
          lessonsDeprecatedByVote: sweep.byVote,
          voteDecayApplied: decayApplied,
        };
      } catch (err) {
        this.deps.logger?.warn?.("consolidator.sweep.failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.running = false;
    }
    this.deps.metrics?.recordConsolidationRun({
      outcome: result.outcome,
      clustersConsidered: result.clustersConsidered,
      lessonsCreated: result.lessonsCreated,
    });
    return result;
  }

  private async runTick(
    signal: AbortSignal,
  ): Promise<ConsolidatorTickResult> {
    const now = this.now();
    const candidates = this.selectCandidates(now);
    if (candidates.length === 0) {
      return zeroSummary();
    }
    const clusters = clusterEpisodes(
      candidates,
      {
        minClusterSize: this.options.minClusterSize,
        requireSharedTag: this.options.requireSharedTag,
        maxClusters: this.options.maxClustersPerTick,
      },
      { linkStore: this.deps.linkStore },
    );
    if (clusters.length === 0) {
      return zeroSummary();
    }

    const byId = new Map<number, MemoryEntry>();
    for (const entry of candidates) byId.set(entry.id, entry);

    let lessonsCreated = 0;
    let lessonsAbstained = 0;
    let failures = 0;

    for (const cluster of clusters) {
      if (signal.aborted) break;
      const acquired = this.acquireClusterLease(cluster, now);
      if (acquired.length < this.options.minClusterSize) {
        // Someone else (or a previous tick) holds part of the cluster.
        this.releaseClusterLease(acquired);
        continue;
      }
      try {
        const ok = await this.distillAndPersist({
          cluster,
          episodesById: byId,
          signal,
        });
        if (ok === "ok") {
          lessonsCreated += 1;
        } else if (ok === "none") {
          lessonsAbstained += 1;
        } else {
          failures += 1;
        }
      } catch (err) {
        failures += 1;
        this.deps.logger?.warn?.("consolidator.cluster.failed", {
          members: cluster.members,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.releaseClusterLease(acquired);
      }
    }

    const outcome: ConsolidatorTickResult["outcome"] =
      lessonsCreated > 0 ? "ok" : failures > 0 ? "failed" : "none";
    return {
      outcome,
      clustersConsidered: clusters.length,
      lessonsCreated,
      lessonsAbstained,
      failures,
      lessonsDeprecatedByAge: 0,
      lessonsDeprecatedByOverflow: 0,
      lessonsDeprecatedByVote: 0,
      voteDecayApplied: false,
    };
  }

  /**
   * Phase 6 — combined deprecation sweep. Runs in two passes:
   *
   *  1. **Age sweep.** `LessonStore.pickAgeDeprecationCandidates`
   *     returns ids where `status='active' AND success_count=0 AND
   *     created_at <= now - deprecationAgeMs`. Each is demoted via
   *     `markDeprecated(id, "aged_out")` which fires the metric +
   *     trace hook.
   *  2. **FIFO sweep.** `LessonStore.pickOverflowForDeprecation`
   *     returns oldest-by-`updated_at` ids when the active count
   *     exceeds `maxEntries`. Each is demoted via
   *     `markDeprecated(id, "overflow")`.
   *
   * The combined sweep is capped at `maxDeprecationsPerTick`
   * (default `100`) so a misconfigured `deprecationAgeMs` cannot
   * flatten the entire lesson set in one tick.
   *
   * Pinned by `consolidator-job.test.ts` ("deprecation sweep demotes
   * aged out lessons" + "overflow sweep demotes oldest by FIFO" +
   * "sweep respects maxDeprecationsPerTick").
   */
  private runDeprecationSweep(now: number): {
    byAge: number;
    byOverflow: number;
    byVote: number;
  } {
    const cap = Math.max(0, this.options.maxDeprecationsPerTick ?? 100);
    if (cap === 0) return { byAge: 0, byOverflow: 0, byVote: 0 };
    let remaining = cap;
    let byAge = 0;
    let byOverflow = 0;
    let byVote = 0;
    // Phase 7a — vote-driven sweep runs **first** so highest-
    // confidence "this is bad" signals retire ahead of age-only
    // candidates when the per-tick cap binds. The predicate
    // (`vote_score < 0 AND success_count = 0`) does **not**
    // depend on `deprecationAgeMs`, so vote curation works even
    // when the age sweep is disabled.
    if (this.options.voteSignalDecay && this.options.voteSignalDecay > 0) {
      const downvoted = this.deps.lessonStore.pickVoteDeprecationCandidates({
        limit: remaining,
      });
      for (const id of downvoted) {
        if (remaining <= 0) break;
        try {
          if (this.deps.lessonStore.markDeprecated(id, "downvoted")) {
            byVote += 1;
            remaining -= 1;
            this.emitLessonDeprecated(id, "downvoted");
          }
        } catch (err) {
          this.deps.logger?.warn?.("consolidator.sweep.vote.failed", {
            lessonId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    const ageMs = this.options.deprecationAgeMs ?? 0;
    if (ageMs > 0) {
      const aged = this.deps.lessonStore.pickAgeDeprecationCandidates({
        now,
        deprecationAgeMs: ageMs,
        limit: remaining,
      });
      for (const id of aged) {
        if (remaining <= 0) break;
        try {
          if (this.deps.lessonStore.markDeprecated(id, "aged_out")) {
            byAge += 1;
            remaining -= 1;
            this.emitLessonDeprecated(id, "aged_out");
          }
        } catch (err) {
          this.deps.logger?.warn?.("consolidator.sweep.age.failed", {
            lessonId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    if (remaining > 0) {
      const overflow = this.deps.lessonStore.pickOverflowForDeprecation();
      for (const id of overflow) {
        if (remaining <= 0) break;
        try {
          if (this.deps.lessonStore.markDeprecated(id, "overflow")) {
            byOverflow += 1;
            remaining -= 1;
            this.emitLessonDeprecated(id, "overflow");
          }
        } catch (err) {
          this.deps.logger?.warn?.("consolidator.sweep.overflow.failed", {
            lessonId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    if (byAge > 0 || byOverflow > 0 || byVote > 0) {
      this.deps.logger?.info?.("consolidator.sweep.done", {
        byAge,
        byOverflow,
        byVote,
      });
    }
    return { byAge, byOverflow, byVote };
  }

  /**
   * Phase 7a — bulk decay of every `vote_score` row across
   * memories / lessons / profile_facts. Pure bookkeeping; never
   * fails the tick. Returns `true` if a decay pass actually ran
   * (factor in (0,1), store wired); `false` otherwise so the
   * tick-result `voteDecayApplied` flag is honest about the
   * "voting is disabled" case.
   *
   * Decay factor handling: a factor of `0` would zero out every
   * score, which we deliberately treat as "do nothing" — set
   * `voting.enabled = false` instead. Factor `1` is no-op
   * (identity); we still emit the metric for observability.
   * Anything outside (0, 1] is clamped by `VoteStore.decayAllScores`.
   */
  private runVoteDecay(): boolean {
    const factor = this.options.voteSignalDecay ?? 0;
    if (factor <= 0) return false;
    const store = this.deps.voteStore;
    if (!store) return false;
    try {
      const result = store.decayAllScores(factor);
      const m = this.deps.metrics;
      if (m) {
        m.recordVotingDecayed({
          kind: "memory",
          rows: result.memories,
          factor,
        });
        m.recordVotingDecayed({
          kind: "lesson",
          rows: result.lessons,
          factor,
        });
        m.recordVotingDecayed({
          kind: "profile",
          rows: result.profileFacts,
          factor,
        });
      }
      return true;
    } catch (err) {
      this.deps.logger?.warn?.("consolidator.vote_decay.failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Pull episodes that survived `cooldownMs` and are not yet
   * archived. The phase 1A utility-weighted eviction has already
   * thinned out useless rows; we just need to exclude "still hot"
   * rows and rows that a previous tick already promoted.
   */
  private selectCandidates(now: number): MemoryEntry[] {
    const threshold = now - this.options.cooldownMs;
    const raw = this.deps.memoryStore.list({
      // We need archived rows out of the way and only the eligible
      // ones. `list` already supports `excludeArchived`, and we
      // post-filter by `updated_at < threshold` since the store
      // does not yet expose an age filter.
      excludeArchived: true,
      limit: 200,
    });
    return raw.filter((entry) => entry.updatedAt <= threshold);
  }

  /**
   * Stamp the consolidator lease on each cluster member. Returns
   * the ids we actually managed to grab; missing ids fell out
   * because someone (the reflection-side `neighbor-evolver` or a
   * sibling tick) already held them.
   */
  private acquireClusterLease(
    cluster: MemoryCluster,
    now: number,
  ): number[] {
    const taken: number[] = [];
    for (const id of cluster.members) {
      const ok = this.deps.memoryStore.acquireConsolidationLease(
        id,
        this.options.consolidationLeaseMs,
        now,
      );
      if (ok) taken.push(id);
    }
    return taken;
  }

  private releaseClusterLease(ids: readonly number[]): void {
    for (const id of ids) {
      try {
        this.deps.memoryStore.releaseConsolidationLease(id);
      } catch {
        // already released or evicted — fine.
      }
    }
  }

  /**
   * Phase 6 — fire the optional `onLessonDeprecated` callback. The
   * caller (bootstrap) bridges it to `TraceBus.emit({ type:
   * "lesson_deprecated", ... })`. Errors are swallowed so a
   * misbehaving sink never derails the sweep.
   */
  private emitLessonDeprecated(lessonId: number, reason: string): void {
    if (!this.deps.onLessonDeprecated) return;
    try {
      this.deps.onLessonDeprecated({ lessonId, reason });
    } catch (err) {
      this.deps.logger?.warn?.("consolidator.trace.failed", {
        lessonId,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async distillAndPersist(args: {
    cluster: MemoryCluster;
    episodesById: Map<number, MemoryEntry>;
    signal: AbortSignal;
  }): Promise<"ok" | "none" | "failed"> {
    const episodes: MemoryEntry[] = [];
    for (const id of args.cluster.members) {
      const entry = args.episodesById.get(id);
      if (entry) episodes.push(entry);
    }
    if (episodes.length < this.options.minClusterSize) return "failed";
    const result = await this.deps.distillRunner.distill({
      // `sessionId` is a correlation tag for trace lookups; the
      // consolidator runs out-of-band so we use a stable
      // namespace.
      sessionId: "consolidator",
      episodes,
      sharedTags: args.cluster.sharedTags,
      signal: args.signal,
    });
    if (result.kind === "ok") {
      const lesson = this.deps.lessonStore.create({
        activation: result.lesson.activation,
        principle: result.lesson.principle,
        tags: result.lesson.tags,
        parentIds: episodes.map((e) => e.id),
        ...(args.cluster.members.length > 0
          ? { workingDir: pickWorkingDir(episodes) }
          : {}),
      });
      this.deps.memoryStore.archiveInto(
        episodes.map((e) => e.id),
        lesson.id,
        this.now(),
      );
      this.deps.logger?.info?.("consolidator.lesson.created", {
        lessonId: lesson.id,
        parentIds: episodes.map((e) => e.id),
      });
      return "ok";
    }
    if (result.kind === "none") {
      return "none";
    }
    return "failed";
  }
}

/** Phase 6: shared zero-summary so the new fields stay in sync. */
function zeroSummary(): ConsolidatorTickResult {
  return {
    outcome: "none",
    clustersConsidered: 0,
    lessonsCreated: 0,
    lessonsAbstained: 0,
    failures: 0,
    lessonsDeprecatedByAge: 0,
    lessonsDeprecatedByOverflow: 0,
    lessonsDeprecatedByVote: 0,
    voteDecayApplied: false,
  };
}

/**
 * Most clusters share a `workingDir` (their member episodes were
 * stamped by the same `runTurn` set). Pick the majority value, or
 * `null` if there is no clear majority. Stored on the new lesson
 * so phase 7a's scope-aware vote filtering has the field to filter
 * on.
 */
function pickWorkingDir(episodes: readonly MemoryEntry[]): string | null {
  const counts = new Map<string, number>();
  for (const entry of episodes) {
    if (entry.workingDir === null) continue;
    counts.set(entry.workingDir, (counts.get(entry.workingDir) ?? 0) + 1);
  }
  let bestDir: string | null = null;
  let bestCount = 0;
  for (const [dir, c] of counts) {
    if (c > bestCount) {
      bestDir = dir;
      bestCount = c;
    }
  }
  return bestDir;
}
