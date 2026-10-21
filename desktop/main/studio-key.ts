/**
 * Studio: the OpenRouter key cloud images and video are paid with, by the
 * agent's own rule (src/tools/image/openrouter-key.ts `openRouterImageKey`):
 * the first `openrouter` provider entry that talks to openrouter.ai and has
 * a key, else `OPENROUTER_API_KEY` (environment, then `<stateDir>/.env`).
 * An entry pointed at another host is a different service and its key is
 * never sent to OpenRouter. The value goes to Core only (loopback
 * `PUT /cloud/providers/openrouter`), never to the window.
 */

export interface KeyedProviderEntry { kind: string; apiKey?: string; apiKeyEnvVar?: string; baseUrl?: string }

export function isOpenRouterHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

/**
 * Pick the key from the provider entries. `resolve` turns an entry into its
 * key value (agent-cli.ts `resolveKeyValue`: the entry's key, its variable,
 * then the env file); the bare `{kind: "openrouter"}` probe reads
 * `OPENROUTER_API_KEY` the same way.
 */
export function pickOpenRouterKey(
  providers: readonly KeyedProviderEntry[],
  resolve: (entry: KeyedProviderEntry) => string | null,
): string | null {
  for (const entry of providers) {
    if (entry.kind !== "openrouter") continue;
    if (entry.baseUrl && !isOpenRouterHost(entry.baseUrl)) continue;
    const key = resolve(entry);
    if (key) return key;
  }
  const fallback = resolve({ kind: "openrouter" });
  return fallback && fallback.trim() ? fallback.trim() : null;
}
