/** The slice of the config the key is read from; structurally satisfied by `AtomicAgentConfig`. */
export interface OpenRouterKeySource {
  readonly llm?: { readonly providers?: readonly { readonly kind: string; readonly apiKey?: string; readonly baseUrl?: string }[] } | undefined;
}

/**
 * The OpenRouter key image generation sends to Core's cloud media: the
 * first `openrouter` provider entry that talks to openrouter.ai and has a
 * key (already resolved from `apiKey` / its env var by the config
 * loader), else `OPENROUTER_API_KEY`. An entry pointed at another host
 * is a different service and its key is never sent to OpenRouter.
 */
export function openRouterImageKey(config: OpenRouterKeySource, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const entry of config.llm?.providers ?? []) {
    if (entry.kind !== "openrouter" || !entry.apiKey) continue;
    if (entry.baseUrl && !isOpenRouterHost(entry.baseUrl)) continue;
    return entry.apiKey;
  }
  const key = env.OPENROUTER_API_KEY?.trim();
  return key ? key : undefined;
}

function isOpenRouterHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch { return false; }
}
