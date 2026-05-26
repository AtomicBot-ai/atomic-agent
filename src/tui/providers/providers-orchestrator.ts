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
  upsertLlmProvider,
  removeLlmProvider,
  writeProviderApiKeyToDotenv,
  wrapLlmConfigError,
} from "../persist-llm-provider.js";
import { OPENROUTER_DEFAULT_CHAT_MODEL } from "./providers-model-options.js";
import { buildProviderEntryFromWizard } from "./providers-wizard-build-entry.js";
import { refreshOpenRouterChatCatalogFromApi } from "../../llm/provider/openrouter/fetch-openrouter-chat-catalog.js";
import { isProvidersAction } from "./providers-actions.js";
import type { ProviderRow } from "./providers-panel-state.js";
import type {
  ProvidersWizardKind,
  ProvidersWizardState,
} from "./providers-wizard-state.js";

/**
 * The only TUI module that calls `runtime.providerRegistry` for
 * provider management.
 */
export class ProvidersOrchestrator {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
  ) {
    this.bus.subscribe((action) => {
      if (!isProvidersAction(action)) return;
      if (action.type === "providers_refresh_requested") {
        this.refresh();
      } else if (action.type === "providers_catalog_refresh_requested") {
        this.prefetchOpenRouterCatalog();
      } else if (action.type === "providers_set_active_text") {
        void this.setActiveText(action.id);
      } else if (action.type === "providers_select_chat_model") {
        void this.selectChatModel(action.providerId, action.modelId);
      } else if (action.type === "providers_select_embedding_model") {
        void this.selectEmbeddingModel(action.providerId, action.modelId);
      } else if (action.type === "providers_set_active_embedding") {
        void this.setActiveEmbedding(action.id);
      }
    });
  }

  /** Refresh chat model list from OpenRouter (best-effort, cached 1h). */
  prefetchOpenRouterCatalog(): void {
    void refreshOpenRouterChatCatalogFromApi().then((ok) => {
      if (ok) {
        this.bus.emit({
          type: "providers_status",
          line: "OpenRouter model list updated from API",
        });
      }
    });
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
      const kind = wizard.kind;
      if (!kind) {
        throw new Error("wizard kind is missing");
      }
      if (wizard.apiKeyBuffer.trim().length > 0) {
        writeProviderApiKeyToDotenv(kind, wizard.apiKeyBuffer);
      } else {
        const config = getConfig();
        const id = wizard.providerId ?? (kind === "openrouter" ? "openrouter" : "openai-compatible");
        const entry = config.llm?.providers.find((p) => p.id === id);
        if (!entry || !resolveLlmProviderApiKey(entry)) {
          throw new Error(
            "API key is empty — paste a key or set it in .env first",
          );
        }
      }

      const built = buildProviderEntryFromWizard({
        kind,
        chatModelId:
          wizard.selectedChatModelId ?? OPENROUTER_DEFAULT_CHAT_MODEL,
        embeddingChoiceId:
          wizard.selectedEmbeddingChoiceId ?? "__local_embedding__",
        baseUrl: wizard.baseUrlLine,
        customChatModel: wizard.chatModelLine,
        customEmbeddingModel: wizard.embeddingModelLine,
      });

      upsertLlmProvider(built.entry, {
        activateEmbeddingProviderId: built.activateEmbeddingProviderId,
      });

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
  return kind === "openrouter" || kind === "openai-compatible";
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
