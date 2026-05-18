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
}

export interface ConsolidatorJobDeps {
  memoryStore: MemoryStore;
  linkStore: LinkStore;
  lessonStore: LessonStore;
  distillRunner: DistillRunner;
  /** Default `Date.now`. Injectable for tests. */
  now?: () => number;
  metrics?: AgentMetrics;
  logger?: StructuredLogger;
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
      return {
        outcome: "none",
        clustersConsidered: 0,
        lessonsCreated: 0,
        lessonsAbstained: 0,
        failures: 0,
      };
    }
    this.running = true;
    const sig = signal ?? new AbortController().signal;
    let result: ConsolidatorTickResult = {
      outcome: "none",
      clustersConsidered: 0,
      lessonsCreated: 0,
      lessonsAbstained: 0,
      failures: 0,
    };
    try {
      result = await this.runTick(sig);
    } catch (err) {
      this.deps.logger?.warn?.("consolidator.tick.failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      result = { ...result, outcome: "failed", failures: result.failures + 1 };
    } finally {
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
      return {
        outcome: "none",
        clustersConsidered: 0,
        lessonsCreated: 0,
        lessonsAbstained: 0,
        failures: 0,
      };
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
      return {
        outcome: "none",
        clustersConsidered: 0,
        lessonsCreated: 0,
        lessonsAbstained: 0,
        failures: 0,
      };
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
    };
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
