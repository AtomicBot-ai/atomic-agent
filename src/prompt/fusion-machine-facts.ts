/**
 * The machine facts the `### fusion` block states.
 *
 * The orchestrator now sizes its own fan-out (see AGENTS.md §"Run modes"),
 * and a model asked to choose a number over hardware it cannot see will
 * either pick the same timid two every time or ask for eight against a
 * one-slot server. So the prefix carries the two facts that actually
 * decide the answer: how many llama-server request slots exist, and
 * which local model the workers run on.
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
import { resolveWorkerSlots } from "../local-llm/worker-slots.js";

export interface FusionMachineFacts {
  /**
   * llama-server request slots (`--parallel`) the worker daemon serves —
   * i.e. how many workers run at once before the rest queue. `null` when
   * the runtime does not own the server and therefore does not know.
   */
  workerSlots: number | null;
  /** The local model serving workers, or `null` when nothing names it. */
  workerModel: string | null;
}

/** Nothing known — the block renders its behavioural lines only. */
export const NO_FUSION_MACHINE_FACTS: FusionMachineFacts = {
  workerSlots: null,
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
  // `--parallel` is only ours to state in managed mode: that is where
  // the runtime itself launches the daemon with `managed.parallel`. An
  // external server was started by the operator with flags this process
  // never saw.
  // `"auto"` is the default now, and it resolves against the context the
  // daemon is launched with — which this process only knows when the
  // operator pinned one (`contextSize: 0` means llama.cpp sizes it from
  // VRAM at start-up, well after the prefix is built). Unknown stays
  // unknown: a guessed slot count is a number the model would plan
  // against, which is the one thing this module refuses to produce.
  const configured = local.mode === "managed" ? local.managed.parallel : null;
  const pinnedContext = local.mode === "managed" ? local.managed.contextSize : 0;
  const workerSlots =
    configured === null
      ? null
      : configured === "auto"
        ? pinnedContext > 0
          ? resolveWorkerSlots({ contextSize: pinnedContext, cpuOnly: false })
          : null
        : configured;

  // Same chain `resolveRunMode` uses for its worker label, minus the
  // resolver: the explicit pin, then the managed daemon's model, then
  // the `model` field of the llama-server provider entry the worker leg
  // names. Never an invented string.
  const fusion = config.llm?.runMode?.fusion;
  const providers = config.llm?.providers ?? [];
  const workerEntry =
    providers.find((p) => p.id === fusion?.workerProvider) ??
    providers.find((p) => p.kind === "llama-server");
  const workerModel =
    nonEmpty(fusion?.workerModel) ??
    (local.mode === "managed" ? nonEmpty(local.managed.modelId) : null) ??
    nonEmpty(workerEntry?.model);

  return { workerSlots, workerModel };
}
