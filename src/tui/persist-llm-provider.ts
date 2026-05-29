import { setDotenvKey } from "../config/dotenv-writer.js";
import {
  ConfigValidationError,
  ensureUserConfigFileSync,
  getConfig,
  parseLlmProviderEntry,
  resetConfigCache,
  writeUserConfigFileSync,
  type UserConfigFile,
  type UserLlmFileConfig,
  type UserLlmProviderEntry,
} from "../config/index.js";
import type { ProvidersWizardKind } from "./providers/providers-wizard-state.js";

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

function readLlmBlockOrDefault(file: UserConfigFile): UserLlmFileConfig {
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
  kind: ProvidersWizardKind,
): "OPENROUTER_API_KEY" | "AIMLAPI_API_KEY" | "OPENAI_COMPAT_API_KEY" {
  if (kind === "openrouter") return "OPENROUTER_API_KEY";
  if (kind === "aimlapi") return "AIMLAPI_API_KEY";
  return "OPENAI_COMPAT_API_KEY";
}

/**
 * Store the API key in `<stateDir>/.env` (mode 0600). Never logged.
 */
export function writeProviderApiKeyToDotenv(
  kind: ProvidersWizardKind,
  apiKey: string,
): void {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) {
    throw new LlmAddProviderError("API key is empty");
  }
  setDotenvKey(getConfig().paths.stateDir, dotenvKeyForProviderKind(kind), trimmed);
  const envKey = dotenvKeyForProviderKind(kind);
  if (!process.env[envKey] || process.env[envKey]!.length === 0) {
    process.env[envKey] = trimmed;
  }
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

export function upsertLlmProvider(
  entry: UserLlmProviderEntry,
  opts?: {
    activateEmbeddingProviderId?: string | null;
  },
): void {
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const base = readLlmBlockOrDefault(file);
  let nextLlm = mergeProviderIntoBlock(base, entry);
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
}

/** @deprecated Prefer {@link upsertLlmProvider}. */
export function persistLlmProvider(entry: UserLlmProviderEntry): void {
  upsertLlmProvider(entry);
}

export function removeLlmProvider(id: string): void {
  if (id === "local-llama") {
    throw new LlmRemoveProviderError('cannot remove built-in provider "local-llama"');
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
  let activeTextProvider = file.llm.activeTextProvider;
  let activeEmbeddingProvider = file.llm.activeEmbeddingProvider;
  if (activeTextProvider === id) {
    activeTextProvider = "local-llama";
  }
  if (activeEmbeddingProvider === id) {
    activeEmbeddingProvider = "local-llama";
  }
  if (!remaining.some((p) => p.id === activeTextProvider)) {
    activeTextProvider = remaining[0]?.id ?? "local-llama";
  }
  if (!remaining.some((p) => p.id === activeEmbeddingProvider)) {
    activeEmbeddingProvider = remaining[0]?.id ?? "local-llama";
  }
  const next: UserConfigFile = {
    ...file,
    llm: {
      ...file.llm,
      activeTextProvider,
      activeEmbeddingProvider,
      providers: remaining,
    },
  };
  writeUserConfigFileSync(path, next);
  resetConfigCache();
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
    throw new LlmRemoveProviderError(`provider "${providerId}" is not configured`);
  }
  writeUserConfigFileSync(path, {
    ...file,
    llm: { ...llm, providers },
  });
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
    throw new LlmRemoveProviderError(`provider "${providerId}" is not configured`);
  }
  writeUserConfigFileSync(path, {
    ...file,
    llm: { ...llm, providers },
  });
  resetConfigCache();
}

export function wrapLlmConfigError(err: unknown): string {
  if (err instanceof LlmAddProviderError || err instanceof LlmRemoveProviderError) {
    return err.message;
  }
  if (err instanceof ConfigValidationError) {
    return `${err.field}: ${err.reason}`;
  }
  return err instanceof Error ? err.message : String(err);
}
