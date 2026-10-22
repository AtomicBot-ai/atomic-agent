import type { AtomicAgentConfig } from "../../config/config-schema.js";
import type { MemoryStore } from "../../memory/memory-store.js";
import type { AgentMetrics } from "../../tracing/agent-metrics.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { MemoryEmbeddingReconnect } from "../runtime-contract.js";
import {
  attachConfiguredEmbeddings,
  type EmbeddingBackfillHandle,
} from "./runtime-memory-stores.js";

type EmbeddingConfig = Pick<AtomicAgentConfig, "paths" | "memory" | "localModels">;

/** The model memory should embed with under `config`, or `null` when embeddings are off. */
function desiredModelId(config: EmbeddingConfig): string | null {
  if (!config.memory.embeddings.enabled || !config.localModels.embeddings.enabled) return null;
  return config.localModels.embeddings.modelId ?? null;
}

/**
 * Keeps the notes store's embedding attachment in step with the configured
 * model while the runtime lives (ATO-351). The boot attaches once; when the
 * operator picks another embedding model, the runtime reconnects here
 * instead of writing the new model's vectors under the old model's name
 * (or failing every write on the dimension check) until a restart.
 *
 * A reconnect stops the running backfill and detaches first, so nothing is
 * written for the old model while the new one is probed. Reachable: the new
 * client is attached and a backfill re-embeds every note it has no vector
 * for. Not reachable: memory stays detached (keyword recall) rather than
 * keeping a client for a model that is no longer configured. Reconnects
 * run one at a time; `stop` (shutdown) waits for one in flight and stops
 * the backfill, and later reconnects are no-ops.
 */
export function createMemoryEmbeddingSwitch(args: {
  notesStore: Pick<MemoryStore, "attachEmbeddings" | "detachEmbeddings" | "getDatabaseHandleForEmbeddings">;
  metrics: AgentMetrics;
  logger?: Pick<StructuredLogger, "info">;
  /** Read at every reconnect: the operator's choice lands in the config file first. */
  readConfig: () => EmbeddingConfig;
  /** What the boot attached. */
  initial: { health: MemoryEmbeddingReconnect["health"]; modelId: string | null; backfill: EmbeddingBackfillHandle | null };
}) {
  const { notesStore, metrics, logger, readConfig } = args;
  let current: MemoryEmbeddingReconnect = {
    health: args.initial.health,
    modelId: args.initial.modelId,
  };
  let backfill = args.initial.backfill;
  let queue: Promise<unknown> = Promise.resolve();
  let stopped = false;

  const reconnectNow = async (): Promise<MemoryEmbeddingReconnect> => {
    if (stopped) return current;
    const config = readConfig();
    const wanted = desiredModelId(config);
    // Already where the config points: a daemon restart or a second
    // pick of the same model must not drop a working attachment.
    if (wanted === null && current.health === "disabled") return { ...current, changed: false };
    if (wanted !== null && current.health === "ok" && current.modelId === wanted) {
      return { ...current, changed: false };
    }
    const previous = backfill;
    backfill = null;
    await previous?.stop();
    notesStore.detachEmbeddings();
    if (stopped) return current;
    const attached = await attachConfiguredEmbeddings({
      notesStore,
      config,
      metrics,
      ...(logger ? { logger } : {}),
    });
    if (stopped) {
      // Shutdown began during the probe: undo, so nothing writes into a
      // store that is about to close.
      await attached.backfill?.stop();
      notesStore.detachEmbeddings();
      return current;
    }
    backfill = attached.backfill;
    current = {
      health: attached.health,
      modelId: attached.modelId,
      ...(attached.failure ? { why: attached.failure.message } : {}),
    };
    return { ...current, changed: true };
  };

  return {
    /** Reattach memory to the model the config names now. Never throws. */
    reconnect(): Promise<MemoryEmbeddingReconnect> {
      const run = queue.then(reconnectNow, reconnectNow);
      queue = run.catch(() => undefined);
      return run.catch((err: unknown) => ({
        health: "unreachable" as const,
        modelId: current.modelId,
        why: err instanceof Error ? err.message : String(err),
        changed: false,
      }));
    },
    /** Shutdown: no more reconnects, wait for one in flight, stop the backfill. */
    async stop(): Promise<void> {
      stopped = true;
      await queue;
      await backfill?.stop();
    },
  };
}

export type MemoryEmbeddingSwitch = ReturnType<typeof createMemoryEmbeddingSwitch>;
