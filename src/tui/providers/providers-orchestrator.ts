import { getConfig } from "../../config/index.js";
import type { UserLlmProviderEntry } from "../../config/index.js";
import { resolveLlmProviderApiKey } from "../../config/resolve-llm-api-key.js";
import { resolveLlmConfig } from "../../llm/provider/registry/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { TuiEventBus } from "../tui-app.js";
import {
  setActiveEmbeddingProviderInConfig,
  setActiveTextProviderInConfig,
  setProviderDefaultChatModelInConfig,
  setProviderDefaultEmbeddingModelInConfig,
  removeLlmProvider,
  wrapLlmConfigError,
} from "../persist-llm-provider.js";
import {
  getCachedAimlapiChatPicks,
  refreshAimlapiChatCatalogFromApi,
} from "../../llm/provider/aimlapi/fetch-aimlapi-chat-catalog.js";
import {
  getCachedOpenRouterChatPicks,
  refreshOpenRouterChatCatalogFromApi,
} from "../../llm/provider/openrouter/fetch-openrouter-chat-catalog.js";
import { fetchOpenAiCompatModels } from "../../llm/provider/openai/fetch-openai-compat-models.js";
import { fetchGeminiModels } from "../../llm/provider/gemini/fetch-gemini-models.js";
import { OPENAI_COMPAT_DEFAULT_BASE_URL } from "./providers-model-options.js";
import { isProvidersAction } from "./providers-actions.js";
import type { ProviderRow } from "./providers-panel-state.js";
import { saveProviderWizardToConfig } from "./save-provider-wizard.js";
import type {
  ProvidersWizardKind,
  ProvidersWizardState,
} from "./providers-wizard-state.js";

/**
 * The only TUI module that calls `runtime.providerRegistry` for
 * provider management.
 */
export class ProvidersOrchestrator {
  /** Backs the picker's stale-response guard; see `openChatModelPicker`. */
  private chatModelPickerGeneration = 0;

  /** Backs the inline model list's stale-response guard; see `ensureInlineModels`. */
  private inlineModelsGeneration = 0;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
  ) {
    this.bus.subscribe((action) => {
      if (!isProvidersAction(action)) return;
      if (action.type === "providers_refresh_requested") {
        this.refresh();
      } else if (action.type === "providers_set_active_text") {
        void this.setActiveText(action.id);
      } else if (action.type === "providers_select_chat_model") {
        void this.selectChatModel(action.providerId, action.modelId);
      } else if (action.type === "providers_chat_model_picker_requested") {
        void this.openChatModelPicker(action.providerId);
      } else if (action.type === "providers_select_embedding_model") {
        void this.selectEmbeddingModel(action.providerId, action.modelId);
      } else if (action.type === "providers_set_active_embedding") {
        void this.setActiveEmbedding(action.id);
      }
    });
  }

  /**
   * Refresh chat model lists from cloud catalog endpoints (best-effort,
   * cached 1h per provider). Today: OpenRouter + aimlapi.
   *
   * Wired to `onProvidersTabRefresh`, so it runs on TUI start and every
   * time the providers/LLM tab activates; the warm-cache guard keeps
   * that to at most one network round-trip per provider per hour. The
   * `providers_status` emit doubles as the re-render trigger that makes
   * already-mounted panels re-read the now-live module cache.
   */
  prefetchCloudCatalogs(): void {
    if (getCachedOpenRouterChatPicks() === null) {
      void refreshOpenRouterChatCatalogFromApi().then((ok) => {
        if (ok) {
          this.bus.emit({
            type: "providers_status",
            line: "OpenRouter model list updated from API",
          });
        }
      });
    }
    if (getCachedAimlapiChatPicks() === null) {
      void refreshAimlapiChatCatalogFromApi().then((ok) => {
        if (ok) {
          this.bus.emit({
            type: "providers_status",
            line: "AI/ML API model list updated from API",
          });
        }
      });
    }
  }

  /**
   * Open the reopenable model picker MODAL for an `openai-compatible`
   * provider and drive its async list fetch. `providerId: null` resolves
   * to the active text provider. No-ops for curated kinds (their models
   * are already first-class rows) and for unknown ids.
   *
   * The Cloud pane and `/model` moved to the inline model list
   * (`ensureInlineModels`); this modal stays for flows outside that
   * pane. Reached via the `onProvidersChatModelPickerRequested`
   * callback, not via a dispatched reducer action, which never reaches
   * this bus.
   */
  async openChatModelPicker(providerId: string | null): Promise<void> {
    const config = getConfig();
    const resolved = resolveLlmConfig(config);
    const id = providerId ?? resolved.activeTextProvider;
    if (!id) return;
    const provider = resolved.providers.find((p) => p.id === id);
    const fileEntry = config.llm?.providers.find((e) => e.id === id);
    if (!provider || provider.kind !== "openai-compatible") return;
    const baseUrl = fileEntry?.baseUrl ?? OPENAI_COMPAT_DEFAULT_BASE_URL;
    // Every open gets a fresh generation so a response from a picker the
    // operator already closed (or reopened for the same provider) cannot
    // repopulate the current one.
    const generation = ++this.chatModelPickerGeneration;
    this.bus.emit({
      type: "providers_chat_model_picker_opened",
      providerId: id,
      currentModelId: fileEntry?.defaultChatModel ?? fileEntry?.model ?? null,
      generation,
    });
    try {
      const apiKey = resolveLlmProviderApiKey(provider) ?? undefined;
      const models = await fetchOpenAiCompatModels(baseUrl, apiKey);
      this.bus.emit({
        type: "providers_chat_model_picker_loaded",
        generation,
        models,
      });
    } catch (err) {
      this.bus.emit({
        type: "providers_chat_model_picker_failed",
        generation,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Make sure the Cloud pane's inline model list has (or is fetching)
   * the catalog of `providerId` (`null` = active text provider).
   * Curated kinds (OpenRouter, aimlapi) resolve synchronously from
   * their catalog module and need no inline state, so they no-op here —
   * the row builder reads them directly. `openai-compatible` and
   * `gemini` providers warm their model cache immediately; a cold cache
   * emits a visible `loading` state, then `loaded` or `failed`.
   *
   * Reached via the `onProvidersInlineModelsEnsureRequested` callback
   * (tab activation, `/model`) and internally after a provider switch —
   * never via a dispatched reducer action, which cannot reach this bus.
   */
  async ensureInlineModels(providerId: string | null): Promise<void> {
    const config = getConfig();
    const resolved = resolveLlmConfig(config);
    const id = providerId ?? resolved.activeTextProvider;
    if (!id) return;
    const provider = resolved.providers.find((p) => p.id === id);
    const fileEntry = config.llm?.providers.find((e) => e.id === id);
    if (!provider || !isCloudProviderKind(provider.kind)) return;
    if (provider.kind !== "openai-compatible" && provider.kind !== "gemini") return;
    const generation = ++this.inlineModelsGeneration;
    this.bus.emit({
      type: "providers_inline_models_loading",
      providerId: id,
      generation,
    });
    const baseUrl = fileEntry?.baseUrl ?? OPENAI_COMPAT_DEFAULT_BASE_URL;
    try {
      const apiKey = resolveLlmProviderApiKey(provider) ?? undefined;
      // Warm 1h cache resolves without a network round-trip, so the
      // loading state is only ever visible on a genuinely cold fetch.
      const models =
        provider.kind === "gemini"
          ? await fetchGeminiModels(apiKey)
          : await fetchOpenAiCompatModels(baseUrl, apiKey);
      this.bus.emit({
        type: "providers_inline_models_loaded",
        providerId: id,
        generation,
        models,
      });
      // Model ids became rows: nudge mounted panels to re-read state.
      this.refresh();
    } catch (err) {
      this.bus.emit({
        type: "providers_inline_models_failed",
        providerId: id,
        generation,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  refresh(): void {
    const config = getConfig();
    const resolved = resolveLlmConfig(config);
    const rows: ProviderRow[] = resolved.providers.map((p) => {
      const fileEntry = config.llm?.providers.find((e) => e.id === p.id);
      return {
        id: p.id,
        kind: p.kind,
        isActiveText: p.id === resolved.activeTextProvider,
        isActiveEmbedding: p.id === resolved.activeEmbeddingProvider,
        hasApiKey: Boolean(resolveLlmProviderApiKey(p)?.length),
        baseUrl: fileEntry?.baseUrl ?? null,
        chatModel: fileEntry?.defaultChatModel ?? fileEntry?.model ?? null,
        chatModelOptions: listChatModelOptionsForEntry(fileEntry),
        embeddingModel: fileEntry?.defaultEmbeddingModel ?? null,
      };
    });
    this.bus.emit({ type: "providers_refresh", rows });
  }

  async setActiveText(id: string): Promise<void> {
    this.bus.emit({ type: "providers_busy", busy: true });
    try {
      await this.runtime.providerRegistry.setActive(id);
      setActiveTextProviderInConfig(id);
      const cfg = getConfig();
      const entry = cfg.llm?.providers.find((p) => p.id === id);
      const model = entry?.defaultChatModel ?? entry?.model ?? "";
      const transport =
        id === "local-llama" ? "grammar+llama-server" : "native_tools";
      this.bus.emit({
        type: "providers_status",
        line: `Active text: ${id}${model ? ` · ${model}` : ""} · ${transport}`,
      });
      this.bus.emit({
        type: "runtime_info",
        line: `Switched active text provider to "${id}". New messages use ${transport}.`,
      });
      this.refresh();
      // The inline Cloud-pane list now shows this provider's models:
      // repopulate it (live fetch with visible loading when the cache
      // is cold). Fire-and-forget so a slow /v1/models cannot delay the
      // switch feedback above.
      void this.ensureInlineModels(id);
    } catch (err) {
      this.bus.emit({
        type: "providers_status",
        line: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.bus.emit({ type: "providers_busy", busy: false });
    }
  }

  async selectChatModel(providerId: string, modelId: string): Promise<void> {
    this.bus.emit({ type: "providers_busy", busy: true });
    try {
      setProviderDefaultChatModelInConfig(providerId, modelId);
      if (this.runtime.providerRegistry.listIds().includes(providerId)) {
        await this.runtime.reloadLlmProvider(providerId);
      } else {
        await this.runtime.reloadLlmProviders();
      }
      await this.setActiveText(providerId);
      this.bus.emit({
        type: "runtime_info",
        line: `Selected chat model ${providerId}/${modelId}.`,
      });
      this.refresh();
    } catch (err) {
      this.bus.emit({
        type: "providers_status",
        line: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.bus.emit({ type: "providers_busy", busy: false });
    }
  }

  async selectEmbeddingModel(providerId: string, modelId: string): Promise<void> {
    this.bus.emit({ type: "providers_busy", busy: true });
    try {
      setProviderDefaultEmbeddingModelInConfig(providerId, modelId);
      if (this.runtime.providerRegistry.listIds().includes(providerId)) {
        await this.runtime.reloadLlmProvider(providerId);
      } else {
        await this.runtime.reloadLlmProviders();
      }
      await this.setActiveEmbedding(providerId);
      this.bus.emit({
        type: "runtime_info",
        line: `Selected embedding model ${providerId}/${modelId}.`,
      });
      this.refresh();
    } catch (err) {
      this.bus.emit({
        type: "providers_status",
        line: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.bus.emit({ type: "providers_busy", busy: false });
    }
  }

  async setActiveEmbedding(id: string): Promise<void> {
    this.bus.emit({ type: "providers_busy", busy: true });
    try {
      setActiveEmbeddingProviderInConfig(id);
      this.bus.emit({
        type: "providers_status",
        line: `Active embedding provider: ${id} (restart agent to apply if recall unchanged)`,
      });
      this.refresh();
    } catch (err) {
      this.bus.emit({
        type: "providers_status",
        line: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.bus.emit({ type: "providers_busy", busy: false });
    }
  }

  async completeWizard(wizard: ProvidersWizardState): Promise<void> {
    this.bus.emit({ type: "providers_wizard_submit_started" });
    try {
      const built = saveProviderWizardToConfig(wizard);
      const exists = this.runtime.providerRegistry
        .listIds()
        .includes(built.entry.id);
      if (exists) {
        await this.runtime.reloadLlmProvider(built.entry.id);
      } else {
        await this.runtime.reloadLlmProviders();
      }

      await this.setActiveText(built.entry.id);

      this.bus.emit({ type: "providers_wizard_succeeded" });
      this.bus.emit({
        type: "runtime_info",
        line: `Active text provider: ${built.entry.id} (${built.entry.defaultChatModel ?? "default model"}). Chat uses cloud native tools now.`,
      });
      this.refresh();
    } catch (err) {
      this.bus.emit({
        type: "providers_wizard_failed",
        error: wrapLlmConfigError(err),
      });
    }
  }

  async removeProviderById(id: string): Promise<void> {
    this.bus.emit({ type: "providers_busy", busy: true });
    try {
      removeLlmProvider(id);
      await this.runtime.providerRegistry.removeProvider(id);
      await this.runtime.reloadLlmProviders();
      this.bus.emit({ type: "providers_remove_succeeded" });
      this.bus.emit({
        type: "runtime_info",
        line: `Removed provider "${id}" from config.`,
      });
      this.refresh();
    } catch (err) {
      this.bus.emit({
        type: "providers_remove_failed",
        error: wrapLlmConfigError(err),
      });
    } finally {
      this.bus.emit({ type: "providers_busy", busy: false });
    }
  }
}

export function isCloudProviderKind(kind: string): kind is ProvidersWizardKind {
  return (
    kind === "openrouter" ||
    kind === "aimlapi" ||
    kind === "gemini" ||
    kind === "openai-compatible"
  );
}

function listChatModelOptionsForEntry(
  entry: UserLlmProviderEntry | undefined,
): readonly string[] {
  if (!entry) return [];
  const out = new Set<string>();
  if (entry.defaultChatModel) out.add(entry.defaultChatModel);
  if (entry.model) out.add(entry.model);
  return [...out];
}
