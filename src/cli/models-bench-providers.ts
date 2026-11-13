import type { AtomicAgentConfig } from "../config/index.js";
import type { LlmProvider } from "../llm/provider/llm-provider.js";
import { registerBuiltInProviderKinds } from "../llm/provider/registry/register-built-in-providers.js";
import {
  getProviderFactory,
  resolveLlmConfig,
  type LlmProviderConfigEntry,
} from "../llm/provider/registry/provider-types.js";
import { StructuredLogger } from "../tracing/index.js";

/**
 * One `--models` item: `<provider>` (its configured chat model) or
 * `<provider>:<model>`. Split at the first colon only, since provider ids
 * have none and model ids may (`ollama:qwen3:8b`).
 */
export interface ModelSpec {
  spec: string;
  providerId: string;
  model?: string;
}

export function parseModelSpecs(raw: string | undefined, fallbackProviderId: string): ModelSpec[] {
  const items = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (items.length === 0) return [{ spec: fallbackProviderId, providerId: fallbackProviderId }];
  return items.map((spec) => {
    const at = spec.indexOf(":");
    if (at === -1) return { spec, providerId: spec };
    const model = spec.slice(at + 1).trim();
    return {
      spec,
      providerId: spec.slice(0, at).trim(),
      ...(model !== "" ? { model } : {}),
    };
  });
}

/** The config entry a spec names, with its model swapped in when it names one. */
export function entryForSpec(
  spec: ModelSpec,
  providers: readonly LlmProviderConfigEntry[],
): LlmProviderConfigEntry | string {
  const entry = providers.find((p) => p.id === spec.providerId);
  if (!entry) {
    const known = providers.map((p) => p.id).join(", ") || "none";
    return `no provider "${spec.providerId}" in the config (configured: ${known})`;
  }
  if (entry.kind === "llama-server") {
    // The built-in local link drives tools through a grammar (GBNF), which
    // cannot produce an invalid call, and needs the runtime's live model
    // profile. Point an openai-compatible provider at the same server to
    // measure the model's own native tool calls.
    return `"${spec.providerId}" is the built-in local link (grammar tool calls); add it as an openai-compatible provider to bench it`;
  }
  return spec.model ? { ...entry, defaultChatModel: spec.model, model: spec.model } : entry;
}

export interface BuiltSpecs {
  providers: Map<string, LlmProvider>;
  /** Specs that could not be built, with the reason. */
  refused: Array<{ spec: string; reason: string }>;
}

/**
 * Build one provider per spec from the config. A spec that fails is
 * reported and left out, so one bad name does not stop the others.
 */
export async function buildSpecProviders(
  config: AtomicAgentConfig,
  specs: readonly ModelSpec[],
): Promise<BuiltSpecs> {
  registerBuiltInProviderKinds();
  const resolved = resolveLlmConfig(config);
  const logger = new StructuredLogger({ level: "error", sinks: [] });
  const providers = new Map<string, LlmProvider>();
  const refused: BuiltSpecs["refused"] = [];
  for (const spec of specs) {
    const entry = entryForSpec(spec, resolved.providers);
    if (typeof entry === "string") {
      refused.push({ spec: spec.spec, reason: entry });
      continue;
    }
    const factory = getProviderFactory(entry.kind);
    if (!factory) {
      refused.push({ spec: spec.spec, reason: `unknown provider kind "${entry.kind}"` });
      continue;
    }
    try {
      providers.set(spec.spec, await factory({ config, entry, logger }));
    } catch (err) {
      refused.push({ spec: spec.spec, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { providers, refused };
}

export async function closeSpecProviders(providers: Map<string, LlmProvider>): Promise<void> {
  await Promise.all([...providers.values()].map((p) => p.close().catch(() => undefined)));
}
