import type { AtomicAgentConfig } from "../../config/config-schema.js";
import type { AgentMetrics } from "../../tracing/agent-metrics.js";
import { ProfileStore, type ProfileStoreOptions } from "../../memory/profile-store.js";
import { MemoryStore } from "../../memory/memory-store.js";
import { LessonStore } from "../../memory/lessons/lesson-store.js";
import { ProcedureStore } from "../../memory/procedures/procedure-store.js";
import { LinkStore } from "../../memory/links/link-store.js";
import { VoteStore } from "../../memory/voting/vote-store.js";
import type { EmbeddingClient } from "../../memory/embeddings/embedding-client.js";
import { createLocalEmbeddingClient, EmbeddingStore, EmbeddingWriter } from "../../memory/embeddings/index.js";
import { getEmbeddingModelDef, isKnownEmbeddingModelId } from "../../local-llm/catalog/models-catalog.js";
import { checkLlamaServer } from "../../llm/llama-server-health.js";

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
}

/** Sequential recipe: derived stores are not constructed before the awaited embedding probe/attachment. */
export async function createRuntimeMemoryStores(args: {
  config: Pick<AtomicAgentConfig, "paths" | "memory" | "localModels">;
  metrics: AgentMetrics;
  onProfileEvicted: NonNullable<ProfileStoreOptions["onEvicted"]>;
}): Promise<RuntimeMemoryStores> {
  const { config, metrics, onProfileEvicted } = args;

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
  // degradation. Conditions to wire it up (in order):
  //
  //   1. Both feature flags on: `memory.embeddings.enabled` AND
  //      `localModels.embeddings.enabled`. Either off ⇒ FTS5-only.
  //   2. A valid embedding model id is configured.
  //   3. Probe `localModels.embeddings.url` for `/health`. Daemon
  //      down ⇒ FTS5-only (logged + counted as `disabled`, not as a
  //      failure — runtime keeps booting).
  //
  // The probe runs in the bootstrap critical path with a short
  // timeout so a stale lockfile / stuck daemon cannot wedge the
  // entire startup. Failure is observability-only: we never throw.
  let embeddingHealth: "ok" | "unreachable" | "disabled" = "disabled";
  let embeddingClient: EmbeddingClient | null = null;
  if (
    config.memory.embeddings.enabled &&
    config.localModels.embeddings.enabled &&
    config.localModels.embeddings.modelId !== null &&
    isKnownEmbeddingModelId(config.localModels.embeddings.modelId)
  ) {
    const embModelDef = getEmbeddingModelDef(
      config.localModels.embeddings.modelId,
    );
    const embUrl = config.localModels.embeddings.url;
    const probe = await checkLlamaServer({
      url: embUrl,
      retries: 0,
      backoffMs: 0,
      timeoutMs: 2000,
    }).catch(() => ({ reachable: false }));
    if (probe.reachable) {
      try {
        // Not a bare `LlamaEmbeddingClient`: a managed embedding daemon
        // requires the key (#582), and `/health` above is exempt from
        // it, so a keyless client would pass the probe and then get 401
        // on every `/embedding`.
        const client = createLocalEmbeddingClient({
          url: embUrl,
          dim: embModelDef.dim,
          model: embModelDef.id,
        });
        embeddingClient = client;
        const embStore = new EmbeddingStore({
          db: notesStore.getDatabaseHandleForEmbeddings(),
        });
        const writer = new EmbeddingWriter({
          client,
          store: embStore,
          metrics,
        });
        notesStore.attachEmbeddings({ writer, store: embStore });
        embeddingHealth = "ok";
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
    } else {
      embeddingHealth = "unreachable";
      process.stderr.write(
        `memory-v2 phase 1B: embedding daemon at ${embUrl} is unreachable; ` +
          `hybrid recall disabled, FTS5-only path active.\n`,
      );
    }
    metrics.recordMemoryEmbeddingsDaemonHealth({
      outcome: embeddingHealth,
      model: embModelDef.id,
    });
  } else {
    metrics.recordMemoryEmbeddingsDaemonHealth({
      outcome: "disabled",
      model: null,
    });
  }

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
  return { profileStore, notesStore, embeddingHealth, embeddingClient, linkStore, lessonStore, procedureStore, voteStore };
}
