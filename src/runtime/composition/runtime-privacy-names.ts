import { getConfig } from "../../config/index.js";
import {
  resolveLlmConfig,
  type LlmProvider,
  type LlmProviderConfigEntry,
  type ProviderRegistry,
  type ResolvedLlmConfig,
} from "../../llm/provider/index.js";
import { isLocalServerUrl } from "../../llm/provider/openai/local-server-url.js";
import {
  createLocalNameDetector,
  setPrivacyNameDetector,
  type LocalNameDetector,
  type LocalNameModel,
} from "../../privacy/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

/**
 * Privacy Shield's local name pass (ATO-2394), wired to the configured
 * providers. Opt-in twice: `privacy.shield.enabled` (the cloud providers
 * only run the pass for a request they mask) and
 * `privacy.shield.localNames`. Both are read per request, so a toggle
 * applies to the next one.
 *
 * Which model: the active text provider when it is local, else the first
 * local provider configured. "Local" is the rule the session readout and
 * the subagent pricing use (a `llama-server` entry, or one on a local
 * server URL), made stricter on one side: a `llama-server` entry pointed
 * at a public host is not local here. No local model means no pass: the
 * request goes out with the regex masks only, and the start-up log says
 * why (`PRIVACY_NAMES_HINT`).
 */

export const PRIVACY_NAMES_HINT =
  "Privacy Shield: privacy.shield.localNames is on, but names, street addresses and organisations need a local model and none is configured; only the regex masks apply.";

/** Output bound of one detection call: a short JSON list. */
const NAME_PASS_MAX_TOKENS = 768;

/** The fallback-chain partition the call would sit in; it never goes through the chain. */
const NAME_PASS_SESSION = "privacy:names";

/** Whether `entry` runs on this machine or the local network. */
export function isLocalProviderEntry(entry: LlmProviderConfigEntry, localModelsUrl: string | undefined): boolean {
  if (entry.kind === "llama-server") {
    return isLocalServerUrl(entry.url ?? entry.baseUrl ?? localModelsUrl);
  }
  return isLocalServerUrl(entry.baseUrl ?? entry.url);
}

/** The provider entry the name pass runs on, or `undefined` for none. */
export function pickLocalNameEntry(
  llm: ResolvedLlmConfig,
  localModelsUrl: string | undefined,
): LlmProviderConfigEntry | undefined {
  const local = llm.providers.filter(
    (p) => p.id !== llm.activeEmbeddingProvider && isLocalProviderEntry(p, localModelsUrl),
  );
  return local.find((p) => p.id === llm.activeTextProvider) ?? local[0];
}

/** One constrained completion on `provider`, as the detector wants it. */
export function localNameModelFor(
  provider: LlmProvider,
  entry: LlmProviderConfigEntry,
  sideCallSlotId: () => number,
): LocalNameModel {
  return {
    id: provider.id,
    local: true,
    async complete({ system, user, grammar, schema, signal }) {
      const result = await provider.complete({
        prompt: `${system}\n\n${user}`,
        // A llama-server link renders these through the model's own template.
        chat: { system, user, prefixHash: "privacy-names", enableThinking: false },
        grammar,
        responseFormat: { name: "privacy_spans", schema, strict: true },
        maxTokens: NAME_PASS_MAX_TOKENS,
        temperature: 0,
        disableThinking: true,
        cachePrompt: false,
        sessionId: NAME_PASS_SESSION,
        signal,
        ...(entry.kind === "llama-server" ? { slotId: sideCallSlotId() } : {}),
      });
      return result.content;
    },
  };
}

export interface PrivacyNamesDeps {
  providerRegistry: Pick<ProviderRegistry, "getProvider">;
  sideCallSlotId: () => number;
  logger: Pick<StructuredLogger, "info" | "warn">;
}

/** Install the name pass for this process. Returns the detector (tests). */
export function installPrivacyNameDetector(deps: PrivacyNamesDeps): LocalNameDetector {
  const resolveModel = (): LocalNameModel | null => {
    const config = getConfig();
    if (config.privacy?.shield.localNames !== true) return null;
    const entry = pickLocalNameEntry(resolveLlmConfig(config), config.localModels.url);
    if (entry === undefined) return null;
    const provider = deps.providerRegistry.getProvider(entry.id);
    if (provider === undefined) return null;
    return localNameModelFor(provider, entry, deps.sideCallSlotId);
  };
  const detector = createLocalNameDetector({
    model: resolveModel,
    onError: (err, modelId) =>
      deps.logger.warn("privacy shield: local name pass failed, regex masks only", {
        provider: modelId,
        error: err instanceof Error ? err.message : String(err),
      }),
  });
  setPrivacyNameDetector(detector);
  const config = getConfig();
  if (
    config.privacy?.shield.localNames === true &&
    pickLocalNameEntry(resolveLlmConfig(config), config.localModels.url) === undefined
  ) {
    deps.logger.info(PRIVACY_NAMES_HINT);
  }
  return detector;
}
