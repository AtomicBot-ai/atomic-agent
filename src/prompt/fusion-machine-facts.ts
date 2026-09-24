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
import { LOCAL_PROVIDER_KIND } from "../config/llm-run-mode-config.js";
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
  /**
   * Single-stream generation speed of the local worker daemon, tokens
   * per second, measured once by the throughput probe at daemon start
   * and held on the model profile manager. `null` until measured, and
   * always for a cloud leg. Measured per daemon instance, so it moves
   * only when the daemon restarts — which drops the local cache anyway.
   */
  tokensPerSecond: number | null;
}

/** Nothing known — the block renders its behavioural lines only. */
export const NO_FUSION_MACHINE_FACTS: FusionMachineFacts = {
  workerLeg: null,
  workerSlots: null,
  workerTokenBudget: null,
  workerModel: null,
  tokensPerSecond: null,
};

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * What the runtime has observed or measured, as opposed to what the
 * config says. The agent loop passes both readings; `buildPrompt` merges
 * them into the config-derived facts.
 *
 * `workerSlots` is the local llama-server's request-slot count as the
 * server itself reported it (`SlotManager.observedPoolSize`), `null`
 * until a `/props` answer has sized the pool. It fills the one gap the
 * config leaves — an external server, whose `--parallel` the operator
 * chose out of band — and it is observed, never guessed, so it may be
 * stated. It moves once, when first observed, and the prefix moves with
 * it: the same one-time cost as a config write.
 *
 * `tokensPerSecond` is the daemon's single-stream decode speed from the
 * throughput probe (`ModelProfileManager.getTokensPerSecond`), `null`
 * until measured. Per daemon instance, so it moves only on a restart —
 * which drops the local cache anyway.
 */
export interface FusionLiveFacts {
  workerSlots?: number | null;
  tokensPerSecond?: number | null;
}

/**
 * Read the facts from an already-loaded config, plus what the runtime
 * has observed where the config is silent.
 *
 * Pure over its arguments so it is testable without touching the config
 * cache; `buildPrompt` passes the `getConfig()` it already holds.
 */
export function resolveFusionMachineFacts(
  config: AtomicAgentConfig,
  live: FusionLiveFacts = {},
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
  // Fusion runs in both directions, so an unpinned worker leg is not
  // "the local daemon" by assumption — it is whichever entry
  // `resolveRunMode` will hand the workers to. Two shapes make the
  // assumption false, and both of them made this module state numbers
  // about a machine that is not running the fan-out:
  //
  // - the orchestrator PINNED to the only llama-server entry. The local
  //   daemon runs the one orchestrating stream, `resolveLocalLegRole`
  //   launches it with `--parallel 1`, and the workers are in the cloud.
  //   Calling the leg local here stated `managed.parallel` — 4 or 5 on a
  //   roomy context — for a one-slot daemon.
  // - no llama-server entry at all. Fusion between two cloud providers
  //   is a shape `resolveRunMode` allows ("which kinds they are is the
  //   operator's business"), and the leg was still called local: the
  //   block stated a slot count, a ~24K worker footprint and the managed
  //   GGUF's name for a daemon that was serving nobody.
  //
  // So mirror the resolver's own chain rather than guessing at it —
  // the same duplication the worker label below already makes, and for
  // the same reason (this module is pure over `AtomicAgentConfig` and
  // does not reach for the resolver). Keeping the *entry* rather than
  // just its kind is what lets the cloud branch name the worker model
  // instead of dropping it.
  const pinnedOrchestrator =
    fusion?.orchestratorProvider === undefined
      ? undefined
      : providers.find((p) => p.id === fusion.orchestratorProvider);
  const activeEntry = providers.find(
    (p) => p.id === config.llm?.activeTextProvider,
  );
  const orchestratorEntry =
    pinnedOrchestrator ??
    (activeEntry !== undefined && activeEntry.kind !== LOCAL_PROVIDER_KIND
      ? activeEntry
      : undefined) ??
    providers.find((p) => p.kind !== LOCAL_PROVIDER_KIND);
  // Local first, then anything that is not already the orchestrator —
  // `resolveRunMode`'s worker chain, verbatim. A leg may not be the
  // other leg, which is what both `p.id !== orchestratorEntry?.id`
  // guards say.
  const unpinnedWorker =
    providers.find(
      (p) =>
        p.kind === LOCAL_PROVIDER_KIND && p.id !== orchestratorEntry?.id,
    ) ?? providers.find((p) => p.id !== orchestratorEntry?.id);
  const workerEntry =
    fusion?.workerProvider === undefined ? unpinnedWorker : pinnedWorker;
  // Nothing resolved: either there are no entries to read — a config
  // with no `llm` block at all, which `resolveLlmConfig` fills with one
  // synthesized llama-server — or the single entry is already the
  // orchestrator. `resolveRunMode` degrades both to a one-leg mode, so
  // the `### fusion` block does not render and the answer is never read;
  // keep the historical "local" rather than inventing a second answer
  // for a state nobody sees.
  const unpinnedWorkerLeg: FusionWorkerLeg =
    unpinnedWorker === undefined
      ? "local"
      : unpinnedWorker.kind === LOCAL_PROVIDER_KIND
        ? "local"
        : "cloud";
  const workerLeg: FusionWorkerLeg | null =
    fusion?.workerProvider === undefined
      ? unpinnedWorkerLeg
      : pinnedWorker === undefined
        ? null
        : pinnedWorker.kind === LOCAL_PROVIDER_KIND
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
  // stated here is the number the daemon launches with. `localLegRole`
  // is spelled out rather than left to default: `configured` is only
  // non-null where the workers are local, which is exactly the
  // `"workers"` role, and saying so keeps the two counts tied together
  // if either side moves again.
  const configuredSlots =
    configured === null
      ? null
      : configured === "auto"
        ? pinnedContext > 0
          ? resolveWorkerSlots({
              contextSize: pinnedContext,
              cpuOnly: local.managed.device === "cpu",
              completionMaxTokens: local.completionMaxTokens,
              localLegRole: "workers",
            })
          : null
        : configured;
  // Where the config cannot say (external mode; managed `"auto"` with the
  // context sized at start-up), the server's own answer may — that is an
  // observation, not a guess. `null` only when nothing at all is known.
  const observedSlots =
    workersAreLocal &&
    typeof live.workerSlots === "number" &&
    Number.isFinite(live.workerSlots) &&
    live.workerSlots > 0
      ? live.workerSlots
      : null;
  const workerSlots = configuredSlots ?? observedSlots;

  // What one worker needs from the pool is a fact about the worker, not
  // the server, so it holds for an external llama-server too.
  const workerTokenBudget = workersAreLocal
    ? workerSlotFootprint(local.completionMaxTokens)
    : null;

  // Same chain `resolveRunMode` uses for its worker label, minus the
  // resolver: the explicit pin, then — for a local leg — the managed
  // daemon's model and the llama-server entry's `model`, or — for a
  // cloud leg — the entry's own chat model. Never an invented string.
  //
  // Read off `workerEntry`, not the pin, so an UNPINNED cloud worker leg
  // is named too. It resolves to a real provider in the config with a
  // real `defaultChatModel`; falling back to the pin alone dropped the
  // name and left the block saying only "workers run on a cloud
  // provider" — honest, but a fact the runtime had in hand and the
  // composer strip was already showing.
  const localEntry =
    workerEntry ?? providers.find((p) => p.kind === LOCAL_PROVIDER_KIND);
  const workerModel =
    nonEmpty(fusion?.workerModel) ??
    (workerLeg === "cloud"
      ? (nonEmpty(workerEntry?.defaultChatModel) ??
        nonEmpty(workerEntry?.model))
      : ((local.mode === "managed" ? nonEmpty(local.managed.modelId) : null) ??
        nonEmpty(localEntry?.model)));

  // A measured figure, never a guessed one — and only for the leg it was
  // measured on. Rounded so the prefix bytes cannot jitter between two
  // readings of the same daemon.
  const tokensPerSecond =
    workersAreLocal &&
    typeof live.tokensPerSecond === "number" &&
    Number.isFinite(live.tokensPerSecond) &&
    live.tokensPerSecond > 0
      ? roundTokensPerSecond(live.tokensPerSecond)
      : null;

  return {
    workerLeg,
    workerSlots,
    workerTokenBudget,
    workerModel,
    tokensPerSecond,
  };
}

/** Whole tokens per second above 10, one decimal below — "~2.6 tok/s". */
export function roundTokensPerSecond(value: number): number {
  return value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
}
