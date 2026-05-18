import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";
import type { LocalLlmMode, UserConfigFile } from "../config/config-schema.js";

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
}): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const nextLocalModels = {
    ...prev.localModels,
    ...(partial.url !== undefined ? { url: partial.url } : {}),
    ...(partial.mode !== undefined ? { mode: partial.mode } : {}),
    managed: {
      ...prev.localModels.managed,
      ...(partial.managed ?? {}),
    },
    embeddings: {
      ...prev.localModels.embeddings,
      ...(partial.embeddings ?? {}),
    },
  };
  const draft = { ...prev, localModels: nextLocalModels };
  const validated = parseUserConfigFile(draft);
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
