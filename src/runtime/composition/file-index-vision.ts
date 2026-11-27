import type { LlmProvider } from "../../llm/index.js";
import { isLocalServerUrl } from "../../llm/provider/openai/local-server-url.js";
import type { ResolvedLlmConfig } from "../../llm/provider/registry/provider-types.js";
import type { VisionModel } from "../../tools/os/media-text/media-text.js";

/**
 * The vision model My files may read scans and photos with (ATO-2501):
 * only one served on this computer or the local network, never a cloud
 * model, whatever the chat runs on. File text is private by default, the
 * same rule the index already follows for embeddings
 * (`runtime-file-index.ts`) and the reranker.
 *
 * Looked up live on every file, so a model loaded or switched after boot
 * is used from the next file on: the active chat provider first when it
 * is local, else the first other local provider that reads images. A
 * llama-server link reads `capabilities.vision` from its live `/props`;
 * one whose model has no projector is passed over.
 *
 * Local means: a `llama-server` entry (Atomic Core and the managed or an
 * External llama-server) whose URL, its own or `localModels.url`, is on
 * this machine or the local network; or any other kind whose `baseUrl`
 * is (LM Studio, Ollama, vLLM). An entry config does not list is never
 * local here, unlike `providerIdIsLlamaServer`, which errs the other way.
 */
export interface LocalVisionRegistry {
  readonly activeTextProviderId: string;
  getProvider(id: string): LlmProvider | undefined;
  listIds(): readonly string[];
}

export interface LocalVisionDeps {
  registry: LocalVisionRegistry;
  /** `resolveLlmConfig(getConfig())`, read on every lookup. */
  readLlm: () => ResolvedLlmConfig;
  /** The runtime `localModels.url` a `llama-server` entry without its own URL talks to. */
  localModelsUrl: () => string;
}

export function pickLocalVisionModel(deps: LocalVisionDeps): VisionModel | undefined {
  let llm: ResolvedLlmConfig;
  try {
    llm = deps.readLlm();
  } catch {
    return undefined;
  }
  const active = deps.registry.activeTextProviderId;
  const ids = [active, ...deps.registry.listIds().filter((id) => id !== active)];
  for (const id of ids) {
    if (!providerIsLocal(llm, id, deps.localModelsUrl())) continue;
    const provider = deps.registry.getProvider(id);
    if (provider !== undefined && provider.capabilities.vision) return provider;
  }
  return undefined;
}

export function providerIsLocal(llm: ResolvedLlmConfig, providerId: string, localModelsUrl: string): boolean {
  const entry = llm.providers.find((p) => p.id === providerId);
  if (entry === undefined) return false;
  if (entry.kind === "llama-server") return isLocalServerUrl(entry.url ?? localModelsUrl);
  return isLocalServerUrl(entry.baseUrl ?? entry.url);
}

/**
 * A slot the file index reads its vision model through. The index is
 * built before the provider registry in `bootstrap.ts`; `attach` hands
 * the registry in once it exists. Until then, and when nothing local
 * reads images, `read` answers `undefined` and scans are skipped with
 * the reason.
 */
export interface LocalVisionSlot {
  read: () => VisionModel | undefined;
  attach: (deps: LocalVisionDeps) => void;
}

export function createLocalVisionSlot(): LocalVisionSlot {
  let deps: LocalVisionDeps | undefined;
  return {
    read: () => (deps === undefined ? undefined : pickLocalVisionModel(deps)),
    attach: (next) => {
      deps = next;
    },
  };
}
