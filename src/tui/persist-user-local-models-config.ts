import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";
import type { LocalLlmMode, UserConfigFile } from "../config/config-schema.js";
import { DEFAULT_EMBEDDING_MODEL_ID } from "../local-llm/index.js";

/**
 * Normalise a user-typed local LLM (llama-server) base URL: trim and add
 * http:// when no scheme is present so `new URL` validation matches user
 * expectations.
 */
export function normalizeLocalLlmBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("URL is empty");
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    new URL(withScheme);
  } catch {
    throw new Error(`invalid URL: ${JSON.stringify(trimmed)}`);
  }
  return withScheme;
}

/**
 * True when `url` resolves to the managed daemon's own loopback address.
 * Pointing external mode at the managed port is legal — it is how you
 * drive a daemon you started yourself with `atomic-agent models start` —
 * so callers that tear the managed daemon down on a switch to external
 * must skip it here, or they would kill the server they just pointed at.
 */
export function pointsAtManagedDaemon(url: string, managedPort: number): boolean {
  try {
    const parsed = new URL(url);
    const loopback =
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      // `new URL` keeps IPv6 hosts bracketed.
      parsed.hostname === "[::1]";
    return loopback && parsed.port === String(managedPort);
  } catch {
    return false;
  }
}

/**
 * Merge local-models-related user config keys, validate, write, and
 * invalidate the global config cache.
 */
export function persistUserLocalModelsConfig(partial: {
  url?: string;
  mode?: LocalLlmMode;
  managed?: Partial<UserConfigFile["localModels"]["managed"]>;
  /**
   * Memory-v2 phase 1B. Subset of `localModels.embeddings` to merge in.
   * Passing `{ enabled: true, modelId: "..." }` is the canonical
   * "operator wants hybrid recall on with this model" mutation.
   */
  embeddings?: Partial<UserConfigFile["localModels"]["embeddings"]>;
  /** Full replacement for `localModels.customModels`. */
  customModels?: UserConfigFile["localModels"]["customModels"];
}): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const nextEmbeddingPort =
    partial.embeddings?.port ?? prev.localModels.embeddings.port;
  const nextLocalModels = {
    ...prev.localModels,
    ...(partial.url !== undefined ? { url: partial.url } : {}),
    ...(partial.mode !== undefined ? { mode: partial.mode } : {}),
    ...(partial.customModels !== undefined
      ? { customModels: partial.customModels }
      : {}),
    managed: {
      ...prev.localModels.managed,
      ...(partial.managed ?? {}),
    },
    embeddings: {
      ...prev.localModels.embeddings,
      ...(partial.embeddings ?? {}),
      ...(partial.embeddings?.port !== undefined &&
      partial.embeddings.url === undefined
        ? { url: `http://127.0.0.1:${nextEmbeddingPort}` }
        : {}),
    },
  };
  const draft = { ...prev, localModels: nextLocalModels };
  const validated = parseUserConfigFile(syncLocalLlamaProviderUrl(draft));
  writeUserConfigFileSync(path, validated);
  resetConfigCache();
}

/**
 * Write `localModels.url` into the user config file and invalidate the
 * global config cache so the next `getConfig()` sees the new base URL.
 */
export function persistUserLocalLlmUrl(nextUrl: string): void {
  persistUserLocalModelsConfig({ url: nextUrl, mode: "external" });
}

export function persistUserRemoteLlmUrls(options: {
  chatUrl: string;
  embeddingUrl?: string;
}): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const hasEmbeddingUrl = options.embeddingUrl !== undefined;
  const draft: UserConfigFile = {
    ...prev,
    localModels: {
      ...prev.localModels,
      mode: "external",
      url: options.chatUrl,
      embeddings: {
        ...prev.localModels.embeddings,
        enabled: hasEmbeddingUrl,
        modelId: hasEmbeddingUrl
          ? (prev.localModels.embeddings.modelId ?? DEFAULT_EMBEDDING_MODEL_ID)
          : null,
        ...(hasEmbeddingUrl ? { url: options.embeddingUrl! } : {}),
      },
    },
    memory: {
      ...prev.memory,
      embeddings: {
        ...prev.memory.embeddings,
        enabled: hasEmbeddingUrl,
      },
    },
  };
  const validated = parseUserConfigFile(syncLocalLlamaProviderUrl(draft));
  writeUserConfigFileSync(path, validated);
  resetConfigCache();
}

function syncLocalLlamaProviderUrl(file: UserConfigFile): UserConfigFile {
  if (!file.llm) return file;
  const url =
    file.localModels.mode === "managed"
      ? `http://127.0.0.1:${file.localModels.managed.port}`
      : file.localModels.url;
  const embeddingUrl = file.localModels.embeddings.url;
  return {
    ...file,
    llm: {
      ...file.llm,
      providers: file.llm.providers.map((provider) =>
        provider.id === "local-llama"
          ? { ...provider, url, baseUrl: embeddingUrl }
          : provider,
      ),
    },
  };
}
