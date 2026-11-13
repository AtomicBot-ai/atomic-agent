import type { AtomicAgentConfig } from "../../../config/index.js";
import type { LlamaServerClient } from "../../llama-server-client.js";
import type { ModelProfile } from "../../model-profile.js";
import type { LlmProvider } from "../llm-provider.js";
import { entryHasNoChatModel } from "./chat-model-guard.js";
import { registerBuiltInProviderKinds } from "./register-built-in-providers.js";
import {
  getProviderFactory,
  resolveLlmConfig,
  type LlmProviderConfigEntry,
  type ProviderFactoryContext,
  type ResolvedLlmConfig,
  type UserModelConfigEntry,
} from "./provider-types.js";

export type { LlmProviderConfigEntry, UserModelConfigEntry, ResolvedLlmConfig };

export {
  registerProviderKind,
  knownProviderKinds,
  resolveLlmConfig,
} from "./provider-types.js";

/**
 * Build one provider entry. A broken entry that is NOT the active text
 * provider (say, a half-finished "add provider" flow that saved a
 * base URL but no model yet) is skipped with a warning instead of
 * taking the whole agent down at boot: the other providers still work,
 * and switching to the broken one later fails with "not configured".
 * The active provider still throws, since there is nothing to run on.
 */
async function buildOrSkip(
  build: () => LlmProvider | Promise<LlmProvider>,
  id: string,
  isActive: boolean,
  logger: ProviderFactoryContext["logger"],
): Promise<LlmProvider | undefined> {
  try {
    return await build();
  } catch (err) {
    if (isActive) throw err;
    logger.warn("llm: provider skipped (invalid config entry)", {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

export class ProviderRegistry {
  private readonly providers: Map<string, LlmProvider>;
  private readonly entries: Map<string, LlmProviderConfigEntry>;
  private activeTextId: string;
  private readonly activeTextListeners = new Set<(id: string) => void>();
  /**
   * Copies of a configured provider built for another chat model, keyed
   * by provider id and model (ATO-1148: a project's own cloud model,
   * asked for per turn). Never active, never listed, never written to
   * the config; dropped with their provider.
   */
  private readonly variants = new Map<string, Map<string, Promise<LlmProvider>>>();
  /** What `fromConfig` / the reload paths built providers with; variants reuse it. */
  private buildCtx: Omit<ProviderFactoryContext, "entry"> | undefined;

  private constructor(
    activeTextId: string,
    providers: Map<string, LlmProvider>,
    // Defaulted so a registry built without its entries (a test double)
    // keeps swapping exactly as before: an unknown entry is not refused.
    entries: Map<string, LlmProviderConfigEntry> = new Map(),
  ) {
    this.activeTextId = activeTextId;
    this.providers = providers;
    this.entries = entries;
  }

  static async fromConfig(
    config: AtomicAgentConfig,
    ctx: Omit<ProviderFactoryContext, "entry"> & {
      llamaClient: LlamaServerClient;
      getProfile: () => ModelProfile;
    },
  ): Promise<ProviderRegistry> {
    registerBuiltInProviderKinds();
    const resolved = resolveLlmConfig(config);
    const built = new Map<string, LlmProvider>();
    const entries = new Map<string, LlmProviderConfigEntry>();
    for (const entry of resolved.providers) {
      const factory = getProviderFactory(entry.kind);
      if (!factory) {
        throw new Error(
          `unknown llm provider kind "${entry.kind}" for id "${entry.id}"`,
        );
      }
      const provider = await buildOrSkip(
        () => factory({ ...ctx, config, entry }),
        entry.id,
        entry.id === resolved.activeTextProvider,
        ctx.logger,
      );
      if (provider) {
        built.set(entry.id, provider);
        entries.set(entry.id, entry);
      }
    }
    if (!built.has(resolved.activeTextProvider)) {
      throw new Error(
        `llm.activeTextProvider "${resolved.activeTextProvider}" is not configured`,
      );
    }
    const registry = new ProviderRegistry(resolved.activeTextProvider, built, entries);
    registry.buildCtx = { ...ctx, config };
    return registry;
  }

  /** Id of the provider serving chat right now (may differ from config until it is re-read). */
  get activeTextProviderId(): string {
    return this.activeTextId;
  }

  get activeText(): LlmProvider {
    const p = this.providers.get(this.activeTextId);
    if (!p) {
      throw new Error(`active text provider "${this.activeTextId}" missing`);
    }
    return p;
  }

  getProvider(id: string): LlmProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * The provider `id` built for `model` instead of the chat model its
   * entry names (ATO-1148). The base provider is returned as-is when it
   * already serves that model. Built once per (id, model) from the same
   * entry and kept until the provider is replaced or removed; the active
   * provider, the entries and the config are not touched, so a turn on
   * a project's model never moves another chat's model.
   *
   * `undefined` when `id` is not configured or the registry has nothing
   * to build with (a test double). A failed build is not cached.
   */
  async modelVariant(id: string, model: string): Promise<LlmProvider | undefined> {
    const base = this.providers.get(id);
    const entry = this.entries.get(id);
    if (!base || !entry) return undefined;
    if ((entry.defaultChatModel ?? entry.model) === model) return base;
    const ctx = this.buildCtx;
    const factory = getProviderFactory(entry.kind);
    if (!ctx || !factory) return undefined;
    const byModel = this.variants.get(id) ?? new Map<string, Promise<LlmProvider>>();
    this.variants.set(id, byModel);
    const known = byModel.get(model);
    if (known) return known;
    const built = Promise.resolve(
      factory({ ...ctx, entry: { ...entry, defaultChatModel: model } }),
    );
    byModel.set(model, built);
    built.catch(() => {
      if (byModel.get(model) === built) byModel.delete(model);
    });
    return built;
  }

  private async dropVariants(id: string): Promise<void> {
    const byModel = this.variants.get(id);
    if (!byModel) return;
    this.variants.delete(id);
    await Promise.all(
      [...byModel.values()].map((p) =>
        p.then((v) => v.close()).catch(() => undefined),
      ),
    );
  }

  listIds(): readonly string[] {
    return [...this.providers.keys()];
  }

  async swapActive(id: string): Promise<LlmProvider> {
    const next = this.providers.get(id);
    if (!next) {
      throw new Error(`llm provider "${id}" is not configured`);
    }
    // Refused before anything moves: listeners, the previous provider's
    // close and every caller's config write all happen after this.
    const entry = this.entries.get(id);
    if (entry && entryHasNoChatModel(entry)) {
      throw new Error(
        `${entry.kind} provider "${id}" has no chat model and cannot be the active text provider`,
      );
    }
    const prev = this.providers.get(this.activeTextId);
    this.activeTextId = id;
    for (const listener of this.activeTextListeners) {
      try {
        listener(id);
      } catch {
        // A listener's failure must not fail the switch it observes.
      }
    }
    if (prev && prev.id !== id) {
      await prev.close().catch(() => undefined);
    }
    return next;
  }

  /**
   * Observe every hot swap of the active text provider, whichever path
   * made it (Cloud pane, `/llm provider`, `/model` from a channel, a
   * session's restored provider, a run-mode change). Called with the new
   * id right after the swap — before most callers persist it, so a
   * listener must take the id from here, not from the config. Returns
   * the unsubscribe.
   */
  onActiveTextChanged(listener: (id: string) => void): () => void {
    this.activeTextListeners.add(listener);
    return () => {
      this.activeTextListeners.delete(listener);
    };
  }

  /** Alias for hot-swap callers (TUI Providers orchestrator). */
  async setActive(id: string): Promise<LlmProvider> {
    return this.swapActive(id);
  }

  /**
   * Register any providers present in config but missing from the
   * in-memory map (TUI add flow). Existing ids are left untouched.
   */
  /**
   * Rebuild one provider from the latest config entry (TUI configure flow).
   */
  async replaceProviderFromConfig(
    id: string,
    config: AtomicAgentConfig,
    ctx: Omit<ProviderFactoryContext, "entry">,
  ): Promise<void> {
    registerBuiltInProviderKinds();
    const entry = resolveLlmConfig(config).providers.find((p) => p.id === id);
    if (!entry) {
      throw new Error(`llm provider "${id}" is not configured`);
    }
    const factory = getProviderFactory(entry.kind);
    if (!factory) {
      throw new Error(
        `unknown llm provider kind "${entry.kind}" for id "${entry.id}"`,
      );
    }
    const prev = this.providers.get(id);
    if (prev) {
      await prev.close().catch(() => undefined);
    }
    // A variant was built from the old entry (key, base URL, headers).
    await this.dropVariants(id);
    this.buildCtx = { ...ctx, config };
    const provider = await factory({ ...ctx, config, entry });
    this.providers.set(id, provider);
    this.entries.set(id, entry);
  }

  async mergeProvidersFromConfig(
    config: AtomicAgentConfig,
    ctx: Omit<ProviderFactoryContext, "entry">,
  ): Promise<readonly string[]> {
    registerBuiltInProviderKinds();
    const resolved = resolveLlmConfig(config);
    this.buildCtx = { ...ctx, config };
    const added: string[] = [];
    for (const entry of resolved.providers) {
      if (this.providers.has(entry.id)) continue;
      const factory = getProviderFactory(entry.kind);
      if (!factory) {
        throw new Error(
          `unknown llm provider kind "${entry.kind}" for id "${entry.id}"`,
        );
      }
      const provider = await buildOrSkip(
        () => factory({ ...ctx, config, entry }),
        entry.id,
        entry.id === this.activeTextId,
        ctx.logger,
      );
      if (!provider) continue;
      this.providers.set(entry.id, provider);
      this.entries.set(entry.id, entry);
      added.push(entry.id);
    }
    return added;
  }

  /**
   * Drop a provider from the registry and close its handle. Refuses
   * when `id` is the active text provider — switch away first.
   */
  async removeProvider(id: string): Promise<void> {
    if (this.activeTextId === id) {
      throw new Error(
        `cannot remove active text provider "${id}" — switch to another provider first`,
      );
    }
    const prev = this.providers.get(id);
    this.providers.delete(id);
    this.entries.delete(id);
    await this.dropVariants(id);
    if (prev) {
      await prev.close().catch(() => undefined);
    }
  }
}
