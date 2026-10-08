import { setDotenvKey } from "./dotenv-writer.js";
import { ConfigValidationError, type UserConfigFile } from "./config-schema.js";
import { ensureUserConfigFileSync, writeUserConfigFileSync } from "./config-file.js";
import { getConfig, resetConfigCache } from "./config-cache.js";
import {
  parseLlmFallbackConfig,
  parseLlmProviderEntry,
  type UserLlmFallbackConfig,
  type UserLlmFileConfig,
  type UserLlmProviderEntry,
} from "./llm-config.js";
import { scrubRunModeProviderPins } from "./llm-run-mode-config.js";
import { defaultProviderModelMode } from "./model-mode.js";

/** Provider kinds accepted by credential persistence, independent of any UI. */
export type ProviderCredentialKind =
  | "claude-cli"
  | "codex-cli"
  | "openrouter"
  | "aimlapi"
  | "gemini"
  | "openai-compatible";

export class LlmAddProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmAddProviderError";
  }
}

export class LlmRemoveProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmRemoveProviderError";
  }
}

/**
 * Why removing `id` is refused: it is the provider serving chat. Shared
 * by the Cloud pane's snapshot guard, the orchestrator's early check and
 * {@link removeLlmProvider} itself, so all three read the same.
 */
export function activeProviderRemovalMessage(id: string): string {
  return `${id} is the active provider; switch to another provider or a local model before removing it`;
}

/** {@link removeLlmProvider} refused `id` because it is the active text provider. */
export class LlmRemoveActiveProviderError extends LlmRemoveProviderError {
  constructor(public readonly providerId: string) {
    super(activeProviderRemovalMessage(providerId));
    this.name = "LlmRemoveActiveProviderError";
  }
}

export function parseAddProviderJson(raw: string): UserLlmProviderEntry {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new LlmAddProviderError("JSON is empty");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new LlmAddProviderError(
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LlmAddProviderError("expected a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.llm && typeof obj.llm === "object" && !Array.isArray(obj.llm)) {
    const llmObj = obj.llm as Record<string, unknown>;
    const providers = llmObj.providers;
    if (!Array.isArray(providers) || providers.length !== 1) {
      throw new LlmAddProviderError(
        'llm envelope must contain exactly one entry in "providers"',
      );
    }
    return parseLlmProviderEntry(providers[0], "llm.providers[0]");
  }
  if (Array.isArray(obj.providers)) {
    if (obj.providers.length !== 1) {
      throw new LlmAddProviderError(
        '"providers" envelope must contain exactly one entry',
      );
    }
    return parseLlmProviderEntry(obj.providers[0], "providers[0]");
  }
  return parseLlmProviderEntry(obj, "provider");
}

function localLlamaUrlFromFile(file: UserConfigFile): string {
  if (file.localModels.mode === "managed") {
    return `http://127.0.0.1:${file.localModels.managed.port}`;
  }
  return file.localModels.url;
}

export function readLlmBlockOrDefault(file: UserConfigFile): UserLlmFileConfig {
  return (
    file.llm ?? {
      activeTextProvider: "local-llama",
      activeEmbeddingProvider: "local-llama",
      toolTransport: "auto",
      providers: [
        {
          id: "local-llama",
          kind: "llama-server",
          url: localLlamaUrlFromFile(file),
        },
      ],
    }
  );
}

export function dotenvKeyForProviderKind(
  kind: ProviderCredentialKind,
):
  | "OPENROUTER_API_KEY"
  | "AIMLAPI_API_KEY"
  | "GEMINI_API_KEY"
  | "OPENAI_COMPAT_API_KEY" {
  if (kind === "openrouter") return "OPENROUTER_API_KEY";
  if (kind === "aimlapi") return "AIMLAPI_API_KEY";
  if (kind === "gemini") return "GEMINI_API_KEY";
  return "OPENAI_COMPAT_API_KEY";
}

/**
 * Store the API key in `<stateDir>/.env` (mode 0600). Never logged.
 */
export function writeProviderApiKeyToDotenv(
  kind: ProviderCredentialKind,
  apiKey: string,
  /**
   * Preset-specific variable (`GROQ_API_KEY`, `TOGETHER_API_KEY`, ...).
   * Without it every preset would share `OPENAI_COMPAT_API_KEY` and a
   * second service would overwrite the first one's key.
   */
  envVarOverride?: string,
): void {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) {
    throw new LlmAddProviderError("API key is empty");
  }
  const envKey = envVarOverride ?? dotenvKeyForProviderKind(kind);
  setDotenvKey(getConfig().paths.stateDir, envKey, trimmed);
  // Always mirror into the live environment, not only when unset: key
  // resolution reads `process.env`, so a session that just rewrote .env
  // must start using the new key now, not after a restart.
  process.env[envKey] = trimmed;
}

function mergeProviderIntoBlock(
  base: UserLlmFileConfig,
  entry: UserLlmProviderEntry,
): UserLlmFileConfig {
  const idx = base.providers.findIndex((p) => p.id === entry.id);
  const providers =
    idx >= 0
      ? base.providers.map((p, i) => (i === idx ? entry : p))
      : [...base.providers, entry];
  return { ...base, providers };
}

/** Preserve saved policy on updates; assign a default only to new connections. */
export function upsertLlmProvider(
  entry: UserLlmProviderEntry,
  opts?: {
    activateEmbeddingProviderId?: string | null;
  },
): UserLlmProviderEntry {
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const base = readLlmBlockOrDefault(file);
  const existing = base.providers.find((provider) => provider.id === entry.id);
  const modelMode = entry.modelMode ?? existing?.modelMode ??
    (existing ? undefined : defaultProviderModelMode(entry));
  const modelModes = entry.modelModes ?? existing?.modelModes;
  const savedEntry = {
    ...entry,
    ...(modelMode !== undefined ? { modelMode } : {}),
    ...(modelModes !== undefined ? { modelModes: { ...modelModes } } : {}),
  };
  let nextLlm = mergeProviderIntoBlock(base, savedEntry);
  if (opts?.activateEmbeddingProviderId) {
    if (
      !nextLlm.providers.some((p) => p.id === opts.activateEmbeddingProviderId)
    ) {
      throw new LlmRemoveProviderError(
        `provider "${opts.activateEmbeddingProviderId}" is not configured`,
      );
    }
    nextLlm = {
      ...nextLlm,
      activeEmbeddingProvider: opts.activateEmbeddingProviderId,
    };
  }
  writeUserConfigFileSync(path, { ...file, llm: nextLlm });
  resetConfigCache();
  return savedEntry;
}

/** @deprecated Prefer {@link upsertLlmProvider}. */
export function persistLlmProvider(entry: UserLlmProviderEntry): void {
  upsertLlmProvider(entry);
}

export function removeLlmProvider(id: string): void {
  if (id === "local-llama") {
    throw new LlmRemoveProviderError(
      'cannot remove built-in provider "local-llama"',
    );
  }
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  if (!file.llm) {
    throw new LlmRemoveProviderError(`provider "${id}" is not configured`);
  }
  const remaining = file.llm.providers.filter((p) => p.id !== id);
  if (remaining.length === file.llm.providers.length) {
    throw new LlmRemoveProviderError(`provider "${id}" is not configured`);
  }
  // Decide on the file just read, not on `getConfig()`: the cache can
  // lag a switch made by another process (Telegram `/model`, a second
  // TUI), and re-pointing chat at `local-llama` here would be silent,
  // with possibly no local model to serve the next turn. Refuse and
  // write nothing; the operator switches first, then removes.
  if (file.llm.activeTextProvider === id) {
    throw new LlmRemoveActiveProviderError(id);
  }
  let activeTextProvider = file.llm.activeTextProvider;
  let activeEmbeddingProvider = file.llm.activeEmbeddingProvider;
  if (activeEmbeddingProvider === id) {
    activeEmbeddingProvider = "local-llama";
  }
  if (!remaining.some((p) => p.id === activeTextProvider)) {
    activeTextProvider = remaining[0]?.id ?? "local-llama";
  }
  if (!remaining.some((p) => p.id === activeEmbeddingProvider)) {
    activeEmbeddingProvider = remaining[0]?.id ?? "local-llama";
  }
  const runMode = scrubRunModeProviderPins(file.llm.runMode, id);
  const fallback = scrubFallbackChain(file.llm.fallback, id);
  const nextLlm: UserLlmFileConfig = {
    ...file.llm,
    activeTextProvider,
    activeEmbeddingProvider,
    providers: remaining,
    ...(runMode ? { runMode } : {}),
  };
  if (fallback) nextLlm.fallback = fallback;
  else delete nextLlm.fallback;
  const next: UserConfigFile = { ...file, llm: nextLlm };
  writeUserConfigFileSync(path, next);
  resetConfigCache();
}

/**
 * Drop a removed provider from `llm.fallback.chain`. The loader rejects a
 * chain id that is not a configured provider (`parseLlmFallbackConfig`),
 * so leaving it behind would make the whole config unreadable on the next
 * load. Timing knobs and `appendLocal` are kept; a chain that ends up
 * empty is omitted, which `resolveFallbackChain` reads as "just the
 * active provider" — the same as an empty one. Returns `undefined` when
 * nothing is left of the block.
 */
function scrubFallbackChain(
  fallback: UserLlmFallbackConfig | undefined,
  id: string,
): UserLlmFallbackConfig | undefined {
  if (!fallback) return undefined;
  const { chain, ...rest } = fallback;
  const nextChain = chain?.filter((entry) => entry !== id);
  const next: UserLlmFallbackConfig =
    nextChain && nextChain.length > 0 ? { ...rest, chain: nextChain } : rest;
  return Object.keys(next).length > 0 ? next : undefined;
}

export function setActiveEmbeddingProviderInConfig(id: string): void {
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const llm = readLlmBlockOrDefault(file);
  if (!llm.providers.some((p) => p.id === id)) {
    throw new LlmRemoveProviderError(`provider "${id}" is not configured`);
  }
  writeUserConfigFileSync(path, {
    ...file,
    llm: { ...llm, activeEmbeddingProvider: id },
  });
  resetConfigCache();
}

export function setActiveTextProviderInConfig(id: string): void {
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const llm = file.llm ?? {
    activeTextProvider: "local-llama",
    activeEmbeddingProvider: "local-llama",
    toolTransport: "auto" as const,
    providers: [
      {
        id: "local-llama",
        kind: "llama-server",
        url: localLlamaUrlFromFile(file),
      },
    ],
  };
  if (!llm.providers.some((p) => p.id === id)) {
    throw new LlmRemoveProviderError(`provider "${id}" is not configured`);
  }
  writeUserConfigFileSync(path, {
    ...file,
    llm: { ...llm, activeTextProvider: id },
  });
  resetConfigCache();
}

export function setProviderDefaultChatModelInConfig(
  providerId: string,
  modelId: string,
): void {
  const trimmed = modelId.trim();
  if (trimmed.length === 0) {
    throw new LlmRemoveProviderError("chat model id is empty");
  }
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const llm = readLlmBlockOrDefault(file);
  let found = false;
  const providers = llm.providers.map((provider) => {
    if (provider.id !== providerId) return provider;
    found = true;
    return { ...provider, defaultChatModel: trimmed };
  });
  if (!found) {
    throw new LlmRemoveProviderError(
      `provider "${providerId}" is not configured`,
    );
  }
  writeUserConfigFileSync(path, {
    ...file,
    llm: { ...llm, providers },
  });
  resetConfigCache();
}

/**
 * Put one provider's `defaultChatModel` back to a previous value —
 * including *unset*, which {@link setProviderDefaultChatModelInConfig}
 * cannot express (it rejects an empty id).
 *
 * This exists for callers that must write the model *before* an
 * operation that can still fail — rebuilding the provider from the
 * now-current config reads it off disk, so it cannot be written after.
 * Without an undo, a failed rebuild leaves the config pinning a model
 * that nothing ever accepted while the caller reports a failure, and
 * the next reader (a `/model` report, the TUI's LLM pane) shows the
 * rejected id as the provider's model. Unknown provider id is a no-op:
 * a rollback path must not throw a second error over the first.
 */
export function restoreProviderDefaultChatModelInConfig(
  providerId: string,
  previous: string | undefined,
): void {
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const llm = readLlmBlockOrDefault(file);
  const providers = llm.providers.map((provider) => {
    if (provider.id !== providerId) return provider;
    if (previous === undefined) {
      const { defaultChatModel: _dropped, ...rest } = provider;
      return rest;
    }
    return { ...provider, defaultChatModel: previous };
  });
  writeUserConfigFileSync(path, { ...file, llm: { ...llm, providers } });
  resetConfigCache();
}

export function setProviderDefaultEmbeddingModelInConfig(
  providerId: string,
  modelId: string,
): void {
  const trimmed = modelId.trim();
  if (trimmed.length === 0) {
    throw new LlmRemoveProviderError("embedding model id is empty");
  }
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const llm = readLlmBlockOrDefault(file);
  let found = false;
  const providers = llm.providers.map((provider) => {
    if (provider.id !== providerId) return provider;
    found = true;
    return { ...provider, defaultEmbeddingModel: trimmed };
  });
  if (!found) {
    throw new LlmRemoveProviderError(
      `provider "${providerId}" is not configured`,
    );
  }
  writeUserConfigFileSync(path, {
    ...file,
    llm: { ...llm, providers },
  });
  resetConfigCache();
}

/**
 * Persist the fallback chain block under `llm.fallback`, preserving any
 * timing knobs the operator set by hand (`failureThreshold`,
 * `cooldownMs`, ...): only `chain` and `appendLocal` — the two the TUI
 * fallback pane edits — are overwritten. The result is re-validated with
 * `parseLlmFallbackConfig` (the same predicate the loader runs) so a
 * chain id that is not a configured provider is rejected here rather than
 * written and then rejected on the next config read.
 *
 * `chain` is written verbatim; the engine's `resolveFallbackChain` still
 * hoists the active text provider to the head and appends the local
 * provider when `appendLocal`, so the stored order is the operator's
 * declared preference, not the effective runtime order.
 */
export function setFallbackChainInConfig(
  chain: readonly string[],
  appendLocal: boolean,
): void {
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const llm = readLlmBlockOrDefault(file);
  const nextFallback: UserLlmFallbackConfig = {
    ...llm.fallback,
    chain: [...chain],
    appendLocal,
  };
  // Re-validate against the live provider set before writing. Throws
  // ConfigValidationError for an unknown id, which the orchestrator
  // surfaces on the status line via `wrapLlmConfigError`.
  const validated = parseLlmFallbackConfig(
    nextFallback,
    new Set(llm.providers.map((p) => p.id)),
    "llm.fallback",
  );
  writeUserConfigFileSync(path, {
    ...file,
    llm: { ...llm, fallback: validated },
  });
  resetConfigCache();
}

export function wrapLlmConfigError(err: unknown): string {
  if (
    err instanceof LlmAddProviderError ||
    err instanceof LlmRemoveProviderError
  ) {
    return err.message;
  }
  if (err instanceof ConfigValidationError) {
    return `${err.field}: ${err.reason}`;
  }
  return err instanceof Error ? err.message : String(err);
}
