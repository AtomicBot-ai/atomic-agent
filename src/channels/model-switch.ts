/**
 * The live half of a model switch: pin the chat model, rebuild the
 * provider from the now-current config, make it active, persist the
 * choice — and undo whatever landed if a leg fails.
 *
 * Shared by `/model` in the chat channels (`model-command.ts`) and by
 * `POST /api/llm/active` (`src/http/route-llm-active.ts`), the route the
 * desktop calls instead of restarting `atag serve` on every model pick
 * (ATO-1021). Both surfaces must land in exactly the same state, which
 * is why the order and the rollback live here once.
 *
 * Swapping the active id alone is not enough: an OpenAI-compatible
 * provider fixes its `defaultChatModel` when it is built, so a new model
 * on the same provider needs the rebuild.
 */

import type { AtomicAgentConfig } from "../config/config-schema.js";
import { getConfig } from "../config/index.js";
import { LOCAL_PROVIDER_KIND } from "../config/llm-run-mode-config.js";
import {
  restoreProviderDefaultChatModelInConfig,
  setActiveTextProviderInConfig,
  setProviderDefaultChatModelInConfig,
} from "../config/llm-provider-commands.js";
import { providerKeyStatus } from "../llm/provider/provider-key.js";
import {
  resolveLlmConfig,
  type LlmProviderConfigEntry,
} from "../llm/provider/registry/index.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";

/**
 * Provider kinds whose factory never reads `entry.defaultChatModel`, so
 * pinning a model on them changes no inference at all. See
 * `model-command.ts` for why writing one anyway is worse than a no-op.
 */
export const MODEL_PIN_IGNORED_KINDS = new Set([LOCAL_PROVIDER_KIND]);

export interface LlmSwitchTarget {
  providerId: string;
  /** The chat model to pin, or `null` to keep the provider's own. */
  modelId: string | null;
  /**
   * What a failed switch puts back as the active provider. Defaults to
   * the config's; the desktop passes the registry's, because it writes
   * the file before it asks for the switch. (For the same reason a failed
   * desktop switch "restores" the model pin the file already holds; the
   * desktop then restarts the agent onto the file, so nothing is lost.)
   */
  previousActiveId?: string;
}

export type LlmSwitchOutcome = { ok: true } | { ok: false; error: string };

/**
 * The key an entry is missing, or `null` when it has one (or needs
 * none). The entry's own `apiKeyEnvVar` from the raw config wins, so a
 * custom kind that declares one is checked too.
 */
export function missingApiKey(
  entry: LlmProviderConfigEntry,
  config: AtomicAgentConfig,
): { envVar: string | null } | null {
  const envVar = config.llm?.providers.find(
    (e) => e.id === entry.id,
  )?.apiKeyEnvVar;
  const status = providerKeyStatus({
    ...entry,
    ...(envVar !== undefined ? { apiKeyEnvVar: envVar } : {}),
  });
  return status.state === "missing" ? { envVar: status.envVar } : null;
}

/**
 * Apply a validated switch to the running agent. Never throws: a failed
 * leg is rolled back and reported as `{ ok: false }`, so "could not
 * switch" always means nothing switched.
 */
export async function switchActiveLlm(
  runtime: AgentRuntime,
  target: LlmSwitchTarget,
): Promise<LlmSwitchOutcome> {
  let previousActiveId: string;
  let previousModelPin: string | undefined;
  try {
    const resolved = resolveLlmConfig(getConfig());
    previousActiveId = target.previousActiveId ?? resolved.activeTextProvider;
    previousModelPin = resolved.providers.find(
      (p) => p.id === target.providerId,
    )?.defaultChatModel;
  } catch (err) {
    return { ok: false, error: messageOf(err) };
  }
  let pinned = false;
  let activated = false;
  try {
    if (target.modelId !== null) {
      setProviderDefaultChatModelInConfig(target.providerId, target.modelId);
      pinned = true;
    }
    // Same order the TUI's `selectChatModel` uses: write the model,
    // rebuild the provider from the now-current config, then make it
    // active. A provider the registry has never built (added to the
    // config after boot) needs the full merge instead of a replace.
    if (runtime.providerRegistry.listIds().includes(target.providerId)) {
      await runtime.reloadLlmProvider(target.providerId);
    } else {
      await runtime.reloadLlmProviders();
    }
    await runtime.providerRegistry.setActive(target.providerId);
    activated = true;
    setActiveTextProviderInConfig(target.providerId);
    return { ok: true };
  } catch (err) {
    // The model pin is written first because rebuilding the provider
    // reads it back off disk, so a rebuild that then fails would leave
    // the config naming a refused model. Undo both legs; each undo
    // swallows its own failure so it cannot mask the real one.
    await rollback(runtime, {
      providerId: target.providerId,
      previousActiveId,
      previousModelPin,
      pinned,
      activated,
    });
    return { ok: false, error: messageOf(err) };
  }
}

async function rollback(
  runtime: AgentRuntime,
  state: {
    providerId: string;
    previousActiveId: string;
    previousModelPin: string | undefined;
    pinned: boolean;
    activated: boolean;
  },
): Promise<void> {
  if (state.pinned) {
    try {
      restoreProviderDefaultChatModelInConfig(
        state.providerId,
        state.previousModelPin,
      );
      // The registry may have been rebuilt from the rejected pin; put
      // its copy back in step with the config too.
      if (runtime.providerRegistry.listIds().includes(state.providerId)) {
        await runtime.reloadLlmProvider(state.providerId);
      }
    } catch {
      // Reported failure stands; nothing better to say here.
    }
  }
  if (state.activated && state.previousActiveId !== state.providerId) {
    try {
      await runtime.providerRegistry.setActive(state.previousActiveId);
    } catch {
      // As above.
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
