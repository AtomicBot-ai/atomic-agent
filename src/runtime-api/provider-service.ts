import type { ProviderCapabilities } from "../llm/provider/llm-provider.js";

import { RuntimeApiError } from "./runtime-api-error.js";

/**
 * LLM provider control surface shared by the sidecar `provider.*` handlers
 * (and any future HTTP route). Mirrors the TUI Providers orchestrator's
 * "mutate registry + persist config + reload" contract, but every config
 * side effect (`setActiveInConfig` / `removeFromConfig`) and registry
 * primitive is **injected** so this facade stays free of the config + TUI
 * layers while reusing one implementation — no drift.
 *
 * The runtime never starts a llama-server; provider ops only re-point the
 * active text backend and rebuild providers from config.
 */
export interface ProviderConfigEntry {
  id: string;
  kind: string;
  /** `defaultChatModel ?? model` from `config.llm.providers`, when present. */
  chatModel: string | null;
  hasApiKey: boolean;
}

export interface ProviderSummary {
  id: string;
  kind: string;
  isActiveText: boolean;
  hasApiKey: boolean;
  chatModel: string | null;
  /** Live capabilities when the provider is registered; `null` otherwise. */
  capabilities: ProviderCapabilities | null;
}

export interface ProviderServiceDeps {
  /** Provider ids currently registered in the live `ProviderRegistry`. */
  listIds: () => readonly string[];
  /** Live capabilities for a registered provider, or `null` when absent. */
  getCapabilities: (id: string) => ProviderCapabilities | null;
  /** Id of the active text provider (`providerRegistry.activeText.id`). */
  getActiveTextId: () => string;
  /** Config-derived enrichment (kind / chatModel / hasApiKey) per provider. */
  listConfigEntries: () => ProviderConfigEntry[];
  /** Hot-swap the active text provider in the live registry. */
  setActive: (id: string) => Promise<void>;
  /** Drop a provider from the live registry (refuses the active one). */
  removeProvider: (id: string) => Promise<void>;
  /** Rebuild one provider from the current config. */
  reloadProvider: (id: string) => Promise<void>;
  /** Merge newly-added config providers into the registry. */
  reloadProviders: () => Promise<void>;
  /** Persist the active text provider id into config.json. */
  setActiveInConfig: (id: string) => void;
  /** Remove a provider entry from config.json by id. */
  removeFromConfig: (id: string) => void;
}

export interface ProviderListResult {
  providers: ProviderSummary[];
  activeTextId: string;
}

export function listProviders(deps: ProviderServiceDeps): ProviderListResult {
  const activeTextId = deps.getActiveTextId();
  const registered = new Set(deps.listIds());
  const entries = deps.listConfigEntries();
  const seen = new Set<string>();
  const providers: ProviderSummary[] = [];
  for (const entry of entries) {
    seen.add(entry.id);
    providers.push({
      id: entry.id,
      kind: entry.kind,
      isActiveText: entry.id === activeTextId,
      hasApiKey: entry.hasApiKey,
      chatModel: entry.chatModel,
      capabilities: registered.has(entry.id)
        ? deps.getCapabilities(entry.id)
        : null,
    });
  }
  // Include registry-only ids (registered but not in config.llm.providers,
  // e.g. the synthesized `local-llama` entry).
  for (const id of registered) {
    if (seen.has(id)) continue;
    providers.push({
      id,
      kind: id === "local-llama" ? "llama-server" : "unknown",
      isActiveText: id === activeTextId,
      hasApiKey: false,
      chatModel: null,
      capabilities: deps.getCapabilities(id),
    });
  }
  return { providers, activeTextId };
}

export async function setActiveProvider(
  deps: ProviderServiceDeps,
  id: string,
): Promise<{ activeTextId: string }> {
  requireId(id);
  if (!deps.listIds().includes(id)) {
    throw new RuntimeApiError(
      `provider "${id}" is not registered`,
      "not_found",
      "id",
    );
  }
  await deps.setActive(id);
  deps.setActiveInConfig(id);
  return { activeTextId: deps.getActiveTextId() };
}

export async function reloadProvider(
  deps: ProviderServiceDeps,
  id?: string,
): Promise<void> {
  if (id !== undefined) {
    requireId(id);
    await deps.reloadProvider(id);
    return;
  }
  await deps.reloadProviders();
}

export async function removeProvider(
  deps: ProviderServiceDeps,
  id: string,
): Promise<void> {
  requireId(id);
  if (id === deps.getActiveTextId()) {
    throw new RuntimeApiError(
      `cannot remove active text provider "${id}" — switch to another provider first`,
      "conflict",
      "id",
    );
  }
  deps.removeFromConfig(id);
  await deps.removeProvider(id);
  await deps.reloadProviders();
}

function requireId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new RuntimeApiError("id is required", "invalid_request", "id");
  }
}
