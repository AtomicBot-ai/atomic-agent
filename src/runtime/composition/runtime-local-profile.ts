import type { AtomicAgentConfig } from "../../config/index.js";
import { getConfig } from "../../config/index.js";
import type { CreateAgentRuntimeOptions } from "../runtime-contract.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { LlamaServerClient } from "../../llm/llama-server-client.js";
import {
  buildGrammar,
  detectModelProfile,
  extractTotalSlots,
  ModelProfileManager,
  PLAIN_INSTRUCT_PROFILE,
} from "../../llm/index.js";
import { checkLlamaServer } from "../../llm/llama-server-health.js";
import { checkProfileGrammarAligned } from "../../llm/profile-invariants.js";
import { DEFAULT_SLOT_COUNT, SlotManager } from "../../llm/slot-manager.js";
import { resolveLlmConfig } from "../../llm/provider/index.js";
import { activeTextProviderIsLlamaServer } from "../../llm/provider/registry/active-text-provider.js";
import { DeferredLocalBackendProbes } from "../../llm/local-backend-gate.js";
import { readLaunchRecord, readRunningPid, readThroughputRecord } from "../../local-llm/index.js";
import { minUsableContextWindow } from "../../prompt/token-budget.js";

type RuntimeInferenceOptions = Pick<CreateAgentRuntimeOptions, "overrides">;

export async function prepareRuntimeLocalProfile(
  config: AtomicAgentConfig,
  options: RuntimeInferenceOptions,
  logger: StructuredLogger,
) {
  const localTextActiveAtBoot = activeTextProviderIsLlamaServer(
    resolveLlmConfig(config),
  );

  // The boot-time local `/health` line. Skipped whole when the route is
  // cloud — including the "deferred" notice, which is advice about a
  // backend this session never talks to.
  const runBootHealthProbe = async (): Promise<void> => {
    if (
      !options.overrides?.skipLlamaHealthCheck &&
      !options.overrides?.deferLlamaHealthCheck &&
      !options.overrides?.llamaComplete
    ) {
      // One attempt, not the retry ladder: this probe exists to log a line,
      // and with llama down the default ladder (5 attempts, exponential
      // backoff) stalled every boot for 15.5 s before the loop then failed
      // fast anyway. The first real completion is the retry.
      const health = await checkLlamaServer({ retries: 0 });
      if (!health.reachable) {
        logger.warn("llama-server health check failed", {
          error: health.error,
          url: config.localModels.url,
        });
        if (config.localModels.mode === "managed") {
          logger.warn(
            managedLocalLlmHealthFailureHint(config.localModels.managed.port),
            {
              mode: "managed",
            },
          );
        }
      } else {
        logger.info("llama-server reachable", {
          url: config.localModels.url,
          latencyMs: health.latencyMs,
        });
      }
    } else if (options.overrides?.deferLlamaHealthCheck) {
      logger.info(
        "llama-server health check deferred; runtime will refresh on first turn",
        {
          url: config.localModels.url,
        },
      );
    }
  };

  if (localTextActiveAtBoot) {
    await runBootHealthProbe();
  } else {
    logger.info(
      "local llama probes skipped; active text provider is not local",
      {
        activeTextProvider: resolveLlmConfig(config).activeTextProvider,
        url: config.localModels.url,
      },
    );
  }

  const llama = new LlamaServerClient();
  const { profile, modelAlias, totalSlots } = await resolveModelProfile(
    options.overrides,
    llama,
    logger,
    config.localModels.url,
    localTextActiveAtBoot,
  );
  const slotManager = new SlotManager(totalSlots ?? undefined);
  if (totalSlots !== null) {
    logger.info("slot manager configured from /props", {
      totalSlots,
      url: config.localModels.url,
    });
  } else {
    // Managed mode always defers the boot probe (the daemon may not be up
    // yet), so this is the normal path there. `ModelProfileManager` calls
    // `slotManager.resize()` on its first successful `/props` refresh at
    // turn start; until then the pool is the single slot every
    // llama-server is guaranteed to have.
    logger.info("slot manager using conservative default (probe deferred)", {
      slotCount: DEFAULT_SLOT_COUNT,
    });
  }

  // A context window that cannot hold the fixed prompt plus a full
  // generation budget makes every step come back `truncated` — the model
  // burns its remaining tokens and never closes a tool-call array. Loud
  // at startup because the failure mode downstream is silent.
  //
  // Advice about the LOCAL server's `--ctx-size` only, so it rides the
  // same gate as the probe that produced the number (issue #112): on a
  // cloud route there is no `/props` reading to judge, and the hints it
  // prints name flags a cloud provider does not have.
  const warnOnSmallContextWindow = (
    candidate: ReturnType<typeof detectModelProfile>,
  ): void => {
    // Judged against the reply reserve the budget really holds on this
    // window, so a cap raised past the window (96k on a 32k model) does
    // not make every model "too small".
    const minUsableCtx = minUsableContextWindow(
      config.localModels.completionMaxTokens,
      candidate.contextWindow,
    );
    if (candidate.contextWindow && candidate.contextWindow < minUsableCtx) {
      logger.warn("context window too small for the agent prompt", {
        contextWindow: candidate.contextWindow,
        required: minUsableCtx,
        completionMaxTokens: config.localModels.completionMaxTokens,
        hint:
          config.localModels.mode === "managed"
            ? "raise localModels.managed.contextSize, lower localModels.completionMaxTokens, or pick a model that fits VRAM"
            : "start llama-server with a larger --ctx-size, or lower localModels.completionMaxTokens",
      });
    }
  };
  if (localTextActiveAtBoot) {
    warnOnSmallContextWindow(profile);
  }


  return {
    llama,
    profile,
    modelAlias,
    slotManager,
    localTextActiveAtBoot,
    runBootHealthProbe,
    warnOnSmallContextWindow,
  };
}

export type RuntimeLocalProfile = Awaited<ReturnType<typeof prepareRuntimeLocalProfile>>;

export async function connectRuntimeLocalProfile(
  config: AtomicAgentConfig,
  options: RuntimeInferenceOptions,
  logger: StructuredLogger,
  local: RuntimeLocalProfile,
) {
  const {
    llama,
    profile,
    modelAlias,
    slotManager,
    localTextActiveAtBoot,
    runBootHealthProbe,
    warnOnSmallContextWindow,
  } = local;
  let grammar = await buildGrammar(profile, config.paths.grammarsDir, {
    browserEnabled: config.browser.enabled,
    reasoningBudgetTokens: config.localModels.reasoningBudgetTokens,
  });
  const grammarViolations = checkProfileGrammarAligned(profile, grammar);
  if (grammarViolations.length > 0) {
    logger.warn("profile/grammar invariant violated", {
      profile: profile.id,
      violations: grammarViolations,
    });
  }

  // Install a hot-swap manager only when the runtime is bound to a real
  // llama-server. Tests that inject `llamaComplete` or `llamaProps*`
  // stub out the HTTP layer and must keep the static profile/grammar
  // pair they already configured.
  const profileManager = shouldInstallProfileManager(options.overrides)
    ? new ModelProfileManager({
        llama,
        initialProfile: profile,
        initialGrammar: grammar,
        initialModelId: modelAlias,
        grammarsDir: config.paths.grammarsDir,
        browserEnabled: config.browser.enabled,
        reasoningBudgetTokens: config.localModels.reasoningBudgetTokens,
        onTotalSlots: (discovered) => {
          if (discovered === slotManager.getSlotCount()) return;
          logger.info("slot pool resized from /props", {
            from: slotManager.getSlotCount(),
            to: discovered,
          });
          slotManager.resize(discovered);
        },
        // The managed daemon's start-time throughput probe leaves its
        // reading next to the pid file; the pid check keeps a previous
        // daemon's figure from describing this one. An external server
        // was never probed, so nothing is read for it.
        ...(config.localModels.mode === "managed"
          ? {
              readThroughput: () => {
                const dataDir = config.paths.localModelsDataDir;
                return (
                  readThroughputRecord(dataDir, readRunningPid(dataDir))
                    ?.tokensPerSecond ?? null
                );
              },
              // Whether the live daemon runs `--swa-full` — what turns a
              // sliding-window model's `prefixReuse` back to `partial`.
              swaFullActive: () => {
                const dataDir = config.paths.localModelsDataDir;
                return (
                  readLaunchRecord(dataDir, readRunningPid(dataDir))
                    ?.swaFull === true
                );
              },
            }
          : {}),
        logger,
      })
    : undefined;

  const getLiveProfile = () => profileManager?.getProfile() ?? profile;
  const getLiveModelId = () => profileManager?.getModelId() ?? modelAlias;

  // Issue #112. The manager above is built either way — construction is
  // pure field assignment, no I/O — because deleting it on a cloud boot
  // would leave a mid-turn fallover to a `llama-server` link running on
  // a frozen `plain-instruct` profile with no way back. What is gated is
  // its *probing*: the boot probes are deferred here and replayed once,
  // lazily, by whichever path reaches local inference first (a provider
  // switch, via the agent loop's turn-start gate, or a cloud→local
  // fallover, via the fallback seam's `prepareLink`).
  const localBackend = new DeferredLocalBackendProbes(
    {
      isActive: () =>
        activeTextProviderIsLlamaServer(resolveLlmConfig(getConfig())),
      restore: async () => {
        logger.info("restoring local llama backend state", {
          url: config.localModels.url,
        });
        try {
          await runBootHealthProbe();
          // `refresh()` is the deferred `/props`: profile, grammar and
          // the slot pool (via `onTotalSlots`) in one round trip. It
          // swallows its own failures and keeps the prior profile.
          await profileManager?.refresh();
          warnOnSmallContextWindow(getLiveProfile());
        } catch (err) {
          // The seam awaits this before a fallover attempt: a throw here
          // would fail the link and advance the chain over a diagnostic.
          // The completion itself is the real verdict on the backend.
          logger.warn("local llama backend restore failed; continuing", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    },
    localTextActiveAtBoot,
  );

  return {
    initialGrammar: grammar,
    profileManager,
    getLiveProfile,
    getLiveModelId,
    localBackend,
  };
}

export type RuntimeConnectedLocalProfile = Awaited<ReturnType<typeof connectRuntimeLocalProfile>>;

/**
 * Log hint when managed mode llama-server is down.
 * Invariant: the agent runtime never spawns llama-server — use
 * `atomic-agent models start`. Exported for unit tests.
 */
export function managedLocalLlmHealthFailureHint(port: number): string {
  const url = `http://127.0.0.1:${port}`;
  return (
    `managed llama-server not reachable at ${url} → run \`atomic-agent models start\` or, if backend/model missing, ` +
    `\`atomic-agent models update\` + \`atomic-agent models pull <id>\``
  );
}


interface ResolvedModelProfile {
  profile: ReturnType<typeof detectModelProfile>;
  /** `/props.model_alias` verbatim, or `null` on fallback / probe miss. */
  modelAlias: string | null;
  /**
   * `/props.total_slots` when the probe succeeded. `null` means the probe
   * was skipped or failed; the caller should fall back to the SlotManager
   * default. Used to keep the in-process slot pool in sync with the server
   * so `slot_id` values we send always exist physically.
   */
  totalSlots: number | null;
}

async function resolveModelProfile(
  overrides: CreateAgentRuntimeOptions["overrides"] | undefined,
  llama: LlamaServerClient,
  logger: StructuredLogger,
  llamaUrl: string,
  /**
   * `false` when the active text provider is not a `llama-server` link:
   * the `/props` probe is skipped entirely and the run starts on the
   * plain profile (issue #112). Deliberately silent — the cloud route is
   * not a failed probe, and the "using plain fallback" warning below
   * would say it was. A later switch or fallover to a local link warms
   * the real profile through `DeferredLocalBackendProbes`.
   */
  probeLocal: boolean,
): Promise<ResolvedModelProfile> {
  if (!probeLocal) {
    return {
      profile: PLAIN_INSTRUCT_PROFILE,
      modelAlias: null,
      totalSlots: null,
    };
  }
  if (overrides?.llamaPropsError) {
    logger.warn("model profile probe failed; using plain fallback", {
      error: overrides.llamaPropsError.message,
      url: llamaUrl,
    });
    return {
      profile: PLAIN_INSTRUCT_PROFILE,
      modelAlias: null,
      totalSlots: null,
    };
  }
  if (overrides?.llamaProps) {
    return logResolvedProfile(overrides.llamaProps, logger);
  }
  if (
    overrides?.llamaComplete ||
    overrides?.skipLlamaHealthCheck ||
    overrides?.deferLlamaHealthCheck
  ) {
    return {
      profile: PLAIN_INSTRUCT_PROFILE,
      modelAlias: null,
      totalSlots: null,
    };
  }
  try {
    const props = await llama.fetchProps();
    return logResolvedProfile(props, logger);
  } catch (error) {
    logger.warn("model profile probe failed; using plain fallback", {
      error: error instanceof Error ? error.message : String(error),
      url: llamaUrl,
    });
    return {
      profile: PLAIN_INSTRUCT_PROFILE,
      modelAlias: null,
      totalSlots: null,
    };
  }
}

function logResolvedProfile(
  props: Record<string, unknown>,
  logger: StructuredLogger,
): ResolvedModelProfile {
  const resolved = detectModelProfile(props);
  const alias =
    typeof props.model_alias === "string" ? props.model_alias : null;
  const totalSlots = extractTotalSlots(props);
  logger.info("model profile resolved", {
    id: resolved.id,
    alias,
    contextWindow: resolved.contextWindow ?? null,
    totalSlots,
  });
  return { profile: resolved, modelAlias: alias, totalSlots };
}

/**
 * Only wire the hot-swap manager when the runtime actually talks to a
 * real llama-server. Any test override that replaces the HTTP layer
 * (fake completions, pre-canned `/props`, or an explicit probe-failure
 * simulation) keeps the legacy static-profile wiring so existing fakes
 * do not need to stand up a fresh `fetchProps` stub.
 */
function shouldInstallProfileManager(
  overrides: CreateAgentRuntimeOptions["overrides"] | undefined,
): boolean {
  if (!overrides) return true;
  if (overrides.llamaComplete) return false;
  if (overrides.llamaProps) return false;
  if (overrides.llamaPropsError) return false;
  if (overrides.skipLlamaHealthCheck) return false;
  return true;
}
