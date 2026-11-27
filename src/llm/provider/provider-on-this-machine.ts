/**
 * ATO-1721: whether a text provider is served on this very machine (a
 * loopback address), as opposed to a cloud service or another computer
 * on the network. This is about where the model runs, not `modelMode`
 * (a behavior policy that a remote custom endpoint also defaults to
 * `local`). Callers use it to keep machine details off remote providers.
 */

import type { AtomicAgentConfig } from "../../config/index.js";
import { isLocalProviderUrl } from "./presets/is-local-provider-url.js";
import { resolveLlmConfig, type LlmProviderConfigEntry } from "./registry/provider-types.js";

/**
 * A provider entry on this machine. `fallbackUrl` is the address a
 * `llama-server` entry without its own URL is reached at
 * (`localModels.url`). No address at all is not proof of locality.
 */
export function isProviderOnThisMachine(
  entry: Pick<LlmProviderConfigEntry, "kind" | "baseUrl" | "url"> | undefined,
  fallbackUrl?: string,
): boolean {
  if (!entry) return false;
  const address =
    entry.baseUrl ?? entry.url ?? (entry.kind === "llama-server" ? fallbackUrl : undefined);
  return isLocalProviderUrl(address);
}

/**
 * The provider serving this prompt (`providerId`, else the active text
 * provider) is on this machine.
 */
export function servedProviderOnThisMachine(
  config: AtomicAgentConfig,
  providerId?: string,
): boolean {
  const llm = resolveLlmConfig(config);
  const id = providerId ?? llm.activeTextProvider;
  return isProviderOnThisMachine(
    llm.providers.find((p) => p.id === id),
    config.localModels.url,
  );
}
