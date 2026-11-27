import type { LlmProvider } from "../llm/provider/llm-provider.js";
import { isLocalProviderUrl } from "../llm/provider/presets/is-local-provider-url.js";
import type { LlmProviderConfigEntry } from "../llm/provider/registry/provider-types.js";

/**
 * The logbook describes screenshots ONLY with a model on this computer.
 * A provider counts as local when its config entry points at a loopback
 * address: a `llama-server` entry (the built-in engine) whose `url` is
 * loopback, or unset and the engine's own `localModels.url` is; any
 * other kind (Ollama, LM Studio as `openai-compatible`) whose `baseUrl`
 * is loopback. A LAN server, a cloud API and the subscription CLIs are
 * never used, whatever model they serve, and there is no fallback to
 * them: with no local vision model the logbook takes no screenshot.
 */
export type LogbookVisionProvider = Pick<LlmProvider, "id" | "name" | "capabilities" | "describeImage"> & {
  readonly chatModelId?: string | undefined;
};

export function entryRunsOnThisMachine(entry: LlmProviderConfigEntry, localModelsUrl: string | undefined): boolean {
  if (entry.kind === "llama-server") {
    const url = entry.url && entry.url.length > 0 ? entry.url : localModelsUrl;
    return isLocalProviderUrl(url);
  }
  return isLocalProviderUrl(entry.baseUrl);
}

export interface PickLocalVisionArgs {
  entries: readonly LlmProviderConfigEntry[];
  activeId: string;
  getProvider: (id: string) => LogbookVisionProvider | undefined;
  localModelsUrl: string | undefined;
}

export type PickLocalVisionResult =
  | { ok: true; provider: LogbookVisionProvider }
  | { ok: false; reason: string };

export const NO_LOCAL_VISION_REASON =
  "no local vision model is loaded. Start a local model that can see images (one with a vision projector); the logbook never sends screenshots to a cloud model";

/** The active provider first when it qualifies, then the others in config order. */
export function pickLocalVisionProvider(args: PickLocalVisionArgs): PickLocalVisionResult {
  const ordered = [
    ...args.entries.filter((e) => e.id === args.activeId),
    ...args.entries.filter((e) => e.id !== args.activeId),
  ];
  for (const entry of ordered) {
    if (!entryRunsOnThisMachine(entry, args.localModelsUrl)) continue;
    const provider = args.getProvider(entry.id);
    if (provider && provider.capabilities.vision === true) return { ok: true, provider };
  }
  return { ok: false, reason: NO_LOCAL_VISION_REASON };
}
