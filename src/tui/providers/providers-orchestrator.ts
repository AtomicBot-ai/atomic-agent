import { getConfig } from "../../config/index.js";
import type { UserLlmProviderEntry } from "../../config/index.js";
import {
  SUBSCRIPTION_CLI_KIND,
  usesExternalCliAuth,
} from "../../config/provider-auth-mode.js";
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
import { verifyWizardBeforeSave } from "./verify-wizard-before-save.js";
import { wizardKindForSubscriptionCli } from "./providers-wizard-state.js";
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

  /** Aborts the pre-save key check when the operator presses Esc. */
  private wizardVerifyAbort: AbortController | null = null;

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
      // `fileEntry` carries this service's header contract
      // (`apiKeyHeader` / `headers`) when it came from a preset, so
      // discovery authenticates exactly the way chat turns will.
      const models = await fetchOpenAiCompatModels(baseUrl, apiKey, fileEntry);
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
          : await fetchOpenAiCompatModels(baseUrl, apiKey, fileEntry);
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
        // A CLI-backed entry has no key by design. Without this the row
        // renders unavailable and Enter is a silent no-op.
        hasApiKey:
          Boolean(resolveLlmProviderApiKey(p)?.length) || usesExternalCliAuth(p),
        baseUrl: fileEntry?.baseUrl ?? null,
        subscriptionCli: fileEntry?.subscriptionCli
          ? { cli: fileEntry.subscriptionCli.cli }
          : null,
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

  /**
   * Abandon the key check a `completeWizard` call is waiting on. The
   * wizard reopens for editing; nothing has been written by this point,
   * because the check runs before the save.
   */
  cancelWizardVerification(): void {
    if (!this.wizardVerifyAbort) return;
    this.wizardVerifyAbort.abort();
    this.wizardVerifyAbort = null;
    this.bus.emit({ type: "providers_wizard_verify_cancelled" });
  }

  async completeWizard(wizard: ProvidersWizardState): Promise<void> {
    this.bus.emit({ type: "providers_wizard_submit_started" });
    const abort = new AbortController();
    this.wizardVerifyAbort = abort;
    try {
      // The key is checked against the service before anything reaches
      // disk: a dead or unfunded key used to be written to .env and made
      // the active provider, and only failed on the first real message.
      const gate = await verifyWizardBeforeSave(wizard, { signal: abort.signal });
      // A cancel already put the wizard back in an editable state; a
      // late verdict from the abandoned check must not overwrite it.
      if (abort.signal.aborted) return;
      // The check is over; from here Esc has nothing to cancel and must
      // not interrupt the save that follows.
      this.wizardVerifyAbort = null;
      if (!gate.proceed) {
        this.bus.emit({ type: "providers_wizard_failed", error: gate.error });
        return;
      }
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
      // The install has a working cloud backend, for the first time if
      // this is the first one. Reported after the gate passed and the
      // entry is active, so it means "set up", not "typed a key in".
      // Only the provider id travels — never the key or the base URL.
      this.runtime.reportModelConfigured(built.entry.id, "cloud");
      if (gate.warning) {
        // Saved, but the key was never proven. Say so where the operator
        // will see it rather than letting the first chat message find out.
        this.bus.emit({ type: "providers_status", line: gate.warning });
        this.bus.emit({ type: "runtime_info", line: gate.warning });
      }
      this.bus.emit({
        type: "runtime_info",
        line: `Active text provider: ${built.entry.id} (${built.entry.defaultChatModel ?? "default model"}). Chat uses cloud native tools now.`,
      });
      // The whole point of a subscription CLI is no per-token billing —
      // but vendor credential precedence usually puts an exported API
      // key ABOVE the CLI's own login, silently inverting that promise.
      // Say so once, where the operator is already looking.
      const cli = built.entry.subscriptionCli?.cli;
      const conflictVar =
        cli === "claude"
          ? "ANTHROPIC_API_KEY"
          : cli === "codex"
            ? "OPENAI_API_KEY"
            : null;
      if (conflictVar && process.env[conflictVar]) {
        const line = `${conflictVar} is exported in this environment — the ${cli} CLI may bill the API per-token instead of your subscription. Unset it before trusting the no-per-token setup.`;
        this.bus.emit({ type: "providers_status", line });
        this.bus.emit({ type: "runtime_info", line });
      }
      this.refresh();
    } catch (err) {
      this.bus.emit({
        type: "providers_wizard_failed",
        error: wrapLlmConfigError(err),
      });
    } finally {
      if (this.wizardVerifyAbort === abort) this.wizardVerifyAbort = null;
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

/**
 * Key-based cloud kinds, whose config `kind` is the wizard row verbatim.
 * Use `configureWizardKindForRow` to decide whether a row can be
 * configured — `subscription-cli` can, and is not one of these.
 */
export function isCloudProviderKind(kind: string): kind is ProvidersWizardKind {
  return (
    kind === "openrouter" ||
    kind === "aimlapi" ||
    kind === "gemini" ||
    kind === "openai-compatible"
  );
}

/**
 * The wizard row `c` (and the LLM tab's configure action) opens for a
 * provider row, or `null` when the row has nothing to configure.
 *
 * `subscription-cli` needs the indirection the cloud kinds do not: two
 * wizard rows collapse onto one config kind, so the stored `kind` alone
 * cannot say whether the entry drives `claude` or `codex` — only the CLI
 * name on the entry can. Without it the key fell through every branch,
 * was swallowed by the panel handler, and did nothing.
 */
export function configureWizardKindForRow(row: {
  kind: string;
  subscriptionCli?: { cli: string } | null;
}): ProvidersWizardKind | null {
  if (isCloudProviderKind(row.kind)) return row.kind;
  if (row.kind === SUBSCRIPTION_CLI_KIND && row.subscriptionCli) {
    return wizardKindForSubscriptionCli(row.subscriptionCli.cli);
  }
  return null;
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
