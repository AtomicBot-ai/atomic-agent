import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";

/**
 * Normalise a user-typed llama-server base URL: trim and add http:// when
 * no scheme is present so `new URL` validation matches user expectations.
 */
export function normalizeLlamaBaseUrl(raw: string): string {
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
 * Write `llama.url` into the user config file and invalidate the global
 * config cache so the next `getConfig()` sees the new base URL.
 */
export function persistUserLlamaUrl(nextUrl: string): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const draft = { ...prev, llama: { ...prev.llama, url: nextUrl } };
  const validated = parseUserConfigFile(draft);
  writeUserConfigFileSync(path, validated);
  resetConfigCache();
}
