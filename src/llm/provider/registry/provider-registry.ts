import type { AtomicAgentConfig } from "../../../config/index.js";
import type { LlamaServerClient } from "../../llama-server-client.js";
import type { ModelProfile } from "../../model-profile.js";
import type { LlmProvider } from "../llm-provider.js";
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

export { registerProviderKind, knownProviderKinds, resolveLlmConfig } from "./provider-types.js";

export class ProviderRegistry {
  private readonly providers: Map<string, LlmProvider>;
  private activeTextId: string;

  private constructor(
    activeTextId: string,
    providers: Map<string, LlmProvider>,
  ) {
    this.activeTextId = activeTextId;
    this.providers = providers;
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
    for (const entry of resolved.providers) {
      const factory = getProviderFactory(entry.kind);
      if (!factory) {
        throw new Error(
          `unknown llm provider kind "${entry.kind}" for id "${entry.id}"`,
        );
      }
      const provider = await factory({
        ...ctx,
        config,
        entry,
      });
      built.set(entry.id, provider);
    }
    if (!built.has(resolved.activeTextProvider)) {
      throw new Error(
        `llm.activeTextProvider "${resolved.activeTextProvider}" is not configured`,
      );
    }
    return new ProviderRegistry(resolved.activeTextProvider, built);
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

  listIds(): readonly string[] {
    return [...this.providers.keys()];
  }

  async swapActive(id: string): Promise<LlmProvider> {
    const next = this.providers.get(id);
    if (!next) {
      throw new Error(`llm provider "${id}" is not configured`);
    }
    const prev = this.providers.get(this.activeTextId);
    this.activeTextId = id;
    if (prev && prev.id !== id) {
      await prev.close().catch(() => undefined);
    }
    return next;
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
    const provider = await factory({ ...ctx, config, entry });
    this.providers.set(id, provider);
  }

  async mergeProvidersFromConfig(
    config: AtomicAgentConfig,
    ctx: Omit<ProviderFactoryContext, "entry">,
  ): Promise<readonly string[]> {
    registerBuiltInProviderKinds();
    const resolved = resolveLlmConfig(config);
    const added: string[] = [];
    for (const entry of resolved.providers) {
      if (this.providers.has(entry.id)) continue;
      const factory = getProviderFactory(entry.kind);
      if (!factory) {
        throw new Error(
          `unknown llm provider kind "${entry.kind}" for id "${entry.id}"`,
        );
      }
      const provider = await factory({
        ...ctx,
        config,
        entry,
      });
      this.providers.set(entry.id, provider);
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
    if (prev) {
      await prev.close().catch(() => undefined);
    }
  }
}
