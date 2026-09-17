/**
 * The machine facts the `### fusion` block states.
 *
 * The orchestrator now sizes its own fan-out (see AGENTS.md §"Run modes"),
 * and a model asked to choose a number over hardware it cannot see will
 * either pick the same timid two every time or ask for eight against a
 * one-slot server. So the prefix carries the facts that actually decide
 * the answer: where the workers run (a local llama-server or a cloud
 * provider), how many llama-server request slots exist, how much of that
 * server's shared context one worker needs, and which model the workers
 * run on.
 *
 * Two rules govern what may go in here.
 *
 * **Cheap and honest, or absent.** Every field is read from config the
 * runtime has already loaded — no probe, no `/props` round trip, no
 * process inspection at prompt-build time. Where a fact is genuinely
 * unknown (an `external` llama-server the operator runs out of band —
 * its `--parallel` is nobody's business but theirs) the field is `null`
 * and the block says nothing about it rather than guessing. A guessed
 * slot count is worse than no slot count: it is a number the model will
 * plan against.
 *
 * **Stable for a given machine state.** These bytes sit in the
 * KV-cache-hot stable prefix, so anything that moves per turn — a clock,
 * a live pool size that resizes after the first `/props`, a counter —
 * would invalidate the cache on every step. Config values change only
 * when the operator writes the config file, which is the same event that
 * already flips the fusion descriptor gate and drops the cache once.
 */

import type { AtomicAgentConfig } from "../config/config-schema.js";
import {
  resolveWorkerSlots,
  workerSlotFootprint,
} from "../local-llm/worker-slots.js";

/** Where fusion's workers run. */
export type FusionWorkerLeg = "local" | "cloud";

export interface FusionMachineFacts {
  /**
   * `local` when the worker leg is a llama-server, `cloud` when it is any
   * other provider, `null` when the pinned worker provider is not in the
   * config (so nothing about it can be stated).
   */
  workerLeg: FusionWorkerLeg | null;
  /**
   * llama-server request slots (`--parallel`) the worker daemon serves —
   * i.e. how many workers run at once before the rest queue. `null` when
   * the runtime does not own the server and therefore does not know, and
   * always for a cloud leg.
   */
  workerSlots: number | null;
  /**
   * Tokens one local worker occupies in the server's shared context — its
   * prompt, what it reads and its reply (`workerSlotFootprint` at
   * `localModels.completionMaxTokens`). `null` for a cloud leg, which has
   * no shared pool to overflow.
   */
  workerTokenBudget: number | null;
  /** The model serving workers, or `null` when nothing names it. */
  workerModel: string | null;
}

/** Nothing known — the block renders its behavioural lines only. */
export const NO_FUSION_MACHINE_FACTS: FusionMachineFacts = {
  workerLeg: null,
  workerSlots: null,
  workerTokenBudget: null,
  workerModel: null,
};

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read the facts from an already-loaded config.
 *
 * Pure over its argument so it is testable without touching the config
 * cache; `buildPrompt` passes the `getConfig()` it already holds.
 */
export function resolveFusionMachineFacts(
  config: AtomicAgentConfig,
): FusionMachineFacts {
  const local = config.localModels;
  const fusion = config.llm?.runMode?.fusion;
  const providers = config.llm?.providers ?? [];
  // An unpinned worker leg is the managed/local daemon — the pairing the
  // mode exists for. A pinned one is whatever kind its entry is: with
  // cloud workers there is no slot pool to speak of — the width is
  // whatever the provider will take concurrently — and stating a number
  // from the idle daemon would be stating a number about the wrong
  // machine.
  const pinnedWorker =
    fusion?.workerProvider === undefined
      ? undefined
      : providers.find((p) => p.id === fusion.workerProvider);
  const workerLeg: FusionWorkerLeg | null =
    fusion?.workerProvider === undefined
      ? "local"
      : pinnedWorker === undefined
        ? null
        : pinnedWorker.kind === "llama-server"
          ? "local"
          : "cloud";
  const workersAreLocal = workerLeg === "local";

  // `--parallel` is only ours to state in managed mode: that is where
  // the runtime itself launches the daemon with `managed.parallel`. An
  // external server was started by the operator with flags this process
  // never saw.
  // `"auto"` is the default now, and it resolves against the context the
  // daemon is launched with — which this process only knows when the
  // operator pinned one (`contextSize: 0` means the context is sized from
  // free memory at start-up, well after the prefix is built). Unknown
  // stays unknown: a guessed slot count is a number the model would plan
  // against, which is the one thing this module refuses to produce.
  const configured =
    workersAreLocal && local.mode === "managed" ? local.managed.parallel : null;
  const pinnedContext = local.mode === "managed" ? local.managed.contextSize : 0;
  // Same inputs `buildLlamaServerArgs` counts slots from, so the number
  // stated here is the number the daemon launches with.
  const workerSlots =
    configured === null
      ? null
      : configured === "auto"
        ? pinnedContext > 0
          ? resolveWorkerSlots({
              contextSize: pinnedContext,
              cpuOnly: local.managed.device === "cpu",
              completionMaxTokens: local.completionMaxTokens,
            })
          : null
        : configured;

  // What one worker needs from the pool is a fact about the worker, not
  // the server, so it holds for an external llama-server too.
  const workerTokenBudget = workersAreLocal
    ? workerSlotFootprint(local.completionMaxTokens)
    : null;

  // Same chain `resolveRunMode` uses for its worker label, minus the
  // resolver: the explicit pin, then — for a local leg — the managed
  // daemon's model and the llama-server entry's `model`, or — for a
  // cloud leg — the entry's own chat model. Never an invented string.
  const localEntry =
    pinnedWorker ?? providers.find((p) => p.kind === "llama-server");
  const workerModel =
    nonEmpty(fusion?.workerModel) ??
    (workerLeg === "cloud"
      ? (nonEmpty(pinnedWorker?.defaultChatModel) ??
        nonEmpty(pinnedWorker?.model))
      : ((local.mode === "managed" ? nonEmpty(local.managed.modelId) : null) ??
        nonEmpty(localEntry?.model)));

  return { workerLeg, workerSlots, workerTokenBudget, workerModel };
}
