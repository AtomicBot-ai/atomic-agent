/**
 * Provider entries the agent cannot build.
 *
 * The agent's `openai-compatible` and `qwen-openai-compatible` kinds refuse
 * to construct without both `baseUrl` and `defaultChatModel`
 * (src/llm/provider/registry/register-built-in-providers.ts). The add-provider
 * wizard writes the entry BEFORE the model step, because `atag models search
 * --provider <id>` needs it in the file to list that provider's models. A
 * wizard abandoned on the model step (closed, backed out of, or the app quit)
 * used to leave that half-written entry behind, and agents up to v0.6.6 built
 * every configured provider at boot, so one such entry stopped `atag serve`
 * from starting at all ("requires baseUrl and defaultChatModel").
 *
 * Pure and dependency-free so it can be unit-tested against the built output
 * (test/provider-hygiene.test.mjs) without Electron.
 */

export interface ProviderLike {
  id?: unknown;
  kind?: unknown;
  baseUrl?: unknown;
  defaultChatModel?: unknown;
}

/** Kinds whose factory throws without a base URL and a chat model. */
const NEEDS_URL_AND_MODEL = new Set(["openai-compatible", "qwen-openai-compatible"]);

const filled = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

/** True when the agent would refuse to build this entry for want of a model or URL. */
export function isIncompleteProvider(entry: ProviderLike | null | undefined): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (typeof entry.kind !== "string" || !NEEDS_URL_AND_MODEL.has(entry.kind)) return false;
  return !filled(entry.baseUrl) || !filled(entry.defaultChatModel);
}

/**
 * Drop every incomplete entry from `config.llm.providers`, in place.
 *
 * An entry is kept, incomplete or not, when anything else in the file names
 * it: the active text or embedding provider, a fallback chain, a Fusion leg.
 * The agent's schema refuses a file whose references point at a missing id,
 * so removing it would turn a skipped provider into a config that cannot be
 * written at all. Only unreferenced entries, which is exactly what an
 * abandoned wizard leaves, are removed. Returns the ids removed (empty when
 * nothing changed).
 */
export function pruneIncompleteProviders(config: unknown): string[] {
  if (!config || typeof config !== "object") return [];
  const llm = (config as { llm?: unknown }).llm as
    | { activeTextProvider?: unknown; providers?: unknown }
    | undefined;
  if (!llm || typeof llm !== "object" || !Array.isArray(llm.providers)) return [];
  const providers = llm.providers as ProviderLike[];
  // Everything in the file except the provider list itself, as text: a
  // quoted id anywhere in it is a reference.
  llm.providers = [];
  const rest = JSON.stringify(config);
  llm.providers = providers;
  const referenced = (id: unknown): boolean =>
    typeof id !== "string" || rest.includes(JSON.stringify(id));
  const removed: string[] = [];
  llm.providers = providers.filter((p) => {
    if (!isIncompleteProvider(p) || referenced(p.id)) return true;
    removed.push(String(p.id));
    return false;
  });
  return removed;
}
