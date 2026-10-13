import type Database from "better-sqlite3";
import type { AtomicAgentConfig } from "../../config/config-schema.js";
import type { AgentMetrics } from "../../tracing/agent-metrics.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { ProfileStore, type ProfileStoreOptions } from "../../memory/profile-store.js";
import { MemoryStore } from "../../memory/memory-store.js";
import { LessonStore } from "../../memory/lessons/lesson-store.js";
import { ProcedureStore } from "../../memory/procedures/procedure-store.js";
import { LinkStore } from "../../memory/links/link-store.js";
import { VoteStore } from "../../memory/voting/vote-store.js";
import type { EmbeddingClient } from "../../memory/embeddings/embedding-client.js";
import {
  backfillEmbeddings,
  countPendingEmbeddings,
  EmbeddingStore,
  EmbeddingWriter,
  type EmbeddingBackfillResult,
} from "../../memory/embeddings/index.js";
import { connectMemoryEmbeddings } from "../../memory/embeddings/memory-embedding-connection.js";

export { probeCoreEmbedding } from "../../memory/embeddings/memory-embedding-connection.js";

/** The runtime owns these four connections; embedding/link/vote wrappers borrow notesStore's handle. */
export interface RuntimeMemoryStores {
  profileStore: ProfileStore;
  notesStore: MemoryStore;
  embeddingHealth: "ok" | "unreachable" | "disabled";
  embeddingClient: EmbeddingClient | null;
  linkStore: LinkStore;
  lessonStore: LessonStore;
  procedureStore: ProcedureStore;
  voteStore: VoteStore | null;
  /** Background re-embed of notes the active model has no vector for; shutdown stops it. */
  embeddingBackfill: EmbeddingBackfillHandle | null;
}

/** Sequential recipe: derived stores are not constructed before the awaited embedding probe/attachment. */
export async function createRuntimeMemoryStores(args: {
  config: Pick<AtomicAgentConfig, "paths" | "memory" | "localModels">;
  metrics: AgentMetrics;
  onProfileEvicted: NonNullable<ProfileStoreOptions["onEvicted"]>;
  /** Receives the backfill's start and end lines. Without it the backfill runs silently. */
  logger?: Pick<StructuredLogger, "info">;
}): Promise<RuntimeMemoryStores> {
  const { config, metrics, onProfileEvicted, logger } = args;

  // TODO(memory-v2): cross-phase invariant 4 — the consolidator
  // (phase 5) registers with the existing `Scheduler` here, not via a
  // new `setInterval`. Bootstrap also gains a check from phase 5
  // onwards: assert `memory.dedup.fts5Threshold ≤
  // memory.consolidation.similarityThreshold` (§13.7.3 / invariant 14),
  // fail-fast on violation.
  const profileStore = new ProfileStore({
    dbFile: config.paths.memoryDbFile,
    metrics,
    maxEntries: config.memory.profile.maxEntries,
    // Issue #407. The store knows no session; a write from a tool call
    // or from reflection runs inside the turn's ALS frame, which names
    // it. The log carries counts only — keys can be sensitive — while
    // the local trace keeps the keys (`/report` strips them).
    onEvicted: onProfileEvicted,
  });
  const notesStore = new MemoryStore({
    dbFile: config.paths.memoryDbFile,
    maxEntries: config.memory.notes.maxEntries,
    dedup: {
      enabled: config.memory.dedup.enabled,
      fts5Threshold: config.memory.dedup.fts5Threshold,
    },
    eviction: {
      utilityWeighted: config.memory.eviction.utilityWeighted,
      maxAgeMs: config.memory.eviction.maxAgeMs,
    },
    metrics,
  });

  // Memory-v2 phase 1B. Embedding plumbing — opt-in, graceful
  // degradation. `connectMemoryEmbeddings` checks the feature flags and
  // the model, and probes it with a short timeout (`memory reindex`
  // reaches the model the same way). Daemon down ⇒ FTS5-only (logged +
  // counted, not a failure — runtime keeps booting). We never throw.
  let embeddingHealth: "ok" | "unreachable" | "disabled" = "disabled";
  let embeddingClient: EmbeddingClient | null = null;
  let embeddingBackfill: EmbeddingBackfillHandle | null = null;
  const connection = await connectMemoryEmbeddings(config);
  if (connection.state === "reachable") {
    try {
      const client = connection.createClient();
      embeddingClient = client;
      const embStore = new EmbeddingStore({
        db: notesStore.getDatabaseHandleForEmbeddings(),
      });
      const writer = new EmbeddingWriter({
        client,
        store: embStore,
        metrics,
      });
      notesStore.attachEmbeddings({
        writer,
        store: embStore,
        // Parsed from config but, before ATO-366, never passed on: recall
        // ran with the store's built-in weights and ceiling.
        fts5Weight: config.memory.embeddings.fts5Weight,
        vectorWeight: config.memory.embeddings.vectorWeight,
        bruteForceCeiling: config.memory.embeddings.bruteForceCeiling,
        ...(connection.minCosine !== undefined ? { minCosine: connection.minCosine } : {}),
      });
      embeddingHealth = "ok";
      if (config.memory.embeddings.backfill) {
        embeddingBackfill = startEmbeddingBackfill({
          db: notesStore.getDatabaseHandleForEmbeddings(),
          writer,
          ...(logger ? { logger } : {}),
        });
      }
    } catch (e) {
      // Construction errors here are pure programmer error
      // (constructor validation): log + degrade, never throw.
      process.stderr.write(
        `memory-v2 phase 1B: failed to wire embedding client: ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
      embeddingHealth = "unreachable";
    }
  } else if (connection.state === "unreachable") {
    embeddingHealth = "unreachable";
    process.stderr.write(
      `memory-v2 phase 1B: ${connection.why}; ` +
        `hybrid recall disabled, FTS5-only path active.\n`,
    );
  }
  metrics.recordMemoryEmbeddingsDaemonHealth({
    outcome: embeddingHealth,
    model: connection.state === "disabled" ? null : connection.modelId,
  });

  // Memory-v2 phase 2. The link graph store rides the same memory.sqlite
  // handle as `notesStore` — `MemoryStore` already enabled
  // `foreign_keys = ON` so the cascade fires on `memories.remove(id)`.
  // The store is always constructed (the table exists from schema v6
  // onwards); the agent-facing recall expansion + link-generator
  // sub-call are independently gated on `memory.links.enabled` /
  // `memory.links.autoGenerate`.
  const linkStore = new LinkStore({
    db: notesStore.getDatabaseHandleForEmbeddings(),
  });

  // Memory-v2 phase 5. `LessonStore` is always constructed when the
  // schema is present (v8+) — the agent-facing tool registration is
  // gated on `memory.lessons.enabled`, and the consolidator is
  // additionally gated on `memory.consolidation.enabled`. Keeping the
  // handle open even when both switches are off is intentional: the
  // SQLite connection lives next to `MemoryStore` / `ProfileStore` /
  // `LinkStore` in the same file and must be closed in `shutdown`.
  const lessonStore = new LessonStore({
    dbFile: config.paths.memoryDbFile,
    maxEntries: config.memory.lessons.maxEntries,
    metrics,
  });

  // Memory-v2 phase 7b. `ProcedureStore` opens its own SQLite connection
  // to the same memory file. Always constructed when the schema (v10+)
  // is present; the runtime closes this owned handle in shutdown.
  // Agent-facing tools and consolidator wiring remain independently
  // gated on `memory.procedures.enabled`.
  const procedureStore = new ProcedureStore({
    dbFile: config.paths.memoryDbFile,
    maxEntries: config.memory.procedures.maxEntries,
    metrics,
  });

  // Memory-v2 phase 7a. `VoteStore` shares the same SQLite handle as
  // the `MemoryStore` (the `vote_score` columns live on the same
  // tables it owns), so there is no separate file to close in
  // `shutdown`. It is always constructed when `memory.voting.enabled`
  // is on; the rest of the wiring (reflection decorator, consolidator
  // dep) is conditional on the same flag.
  const voteStore: VoteStore | null = config.memory.voting.enabled
    ? new VoteStore({
        db: notesStore.getDatabaseHandleForEmbeddings(),
      })
    : null;
  return { profileStore, notesStore, embeddingHealth, embeddingClient, linkStore, lessonStore, procedureStore, voteStore, embeddingBackfill };
}

export interface EmbeddingBackfillHandle {
  /** Settles with the run's result, or `null` when it never started (stopped during the delay). */
  readonly done: Promise<EmbeddingBackfillResult | null>;
  /** Abort the run (an in-flight embed included) and wait for it to settle. */
  stop(): Promise<void>;
}

/**
 * Start re-embedding, in the background, the notes the attached model has
 * no vector for (a model switch, or embeddings turned on over an existing
 * corpus). Returns `null` when there is nothing to do.
 *
 * Low priority by construction: it waits `startDelayMs` before the first
 * embed (a short-lived runtime, such as `run` or `task run`, shuts down
 * before it starts), embeds one note at a time in small batches and
 * sleeps between batches, so live writes and recall queries share the
 * model with it. Its timers are unref'd and shutdown aborts the in-flight
 * request: it never holds a process open. A model that goes down ends the
 * run quietly; the next boot resumes where it stopped.
 */
export function startEmbeddingBackfill(args: {
  db: Database.Database;
  writer: EmbeddingWriter;
  logger?: Pick<StructuredLogger, "info">;
  startDelayMs?: number;
  pauseMs?: number;
  batchSize?: number;
}): EmbeddingBackfillHandle | null {
  const { db, writer, logger } = args;
  const model = writer.client.model;
  try {
    if (countPendingEmbeddings(db, model) === 0) return null;
  } catch {
    return null;
  }
  const controller = new AbortController();
  const { signal } = controller;
  const done = (async (): Promise<EmbeddingBackfillResult | null> => {
    await sleep(args.startDelayMs ?? BACKFILL_START_DELAY_MS, signal);
    if (signal.aborted) return null;
    logger?.info("memory embeddings backfill started", {
      model,
      pending: countPendingEmbeddings(db, model),
    });
    const result = await backfillEmbeddings(
      { db, writer },
      {
        batchSize: args.batchSize ?? BACKFILL_BATCH_SIZE,
        concurrency: 1,
        signal,
        pause: () => sleep(args.pauseMs ?? BACKFILL_PAUSE_MS, signal),
      },
    );
    logger?.info("memory embeddings backfill finished", {
      model,
      embedded: result.embedded,
      skipped: result.skipped,
      remaining: result.remaining,
      ...(result.stoppedReason ? { stoppedReason: result.stoppedReason } : {}),
    });
    return result;
  })().catch(() => null);
  return {
    done,
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

const BACKFILL_START_DELAY_MS = 15_000;
const BACKFILL_PAUSE_MS = 250;
const BACKFILL_BATCH_SIZE = 8;

/** Resolves after `ms`, or at once on abort. Unref'd: never keeps the process alive. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
