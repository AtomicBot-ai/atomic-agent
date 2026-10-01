import { getConfig } from "../config/index.js";
import { catalogForProvider } from "../llm/provider/catalog-for-provider.js";
import {
  formatCapabilitySummary,
  formatContextWindow,
  formatTokenPrice,
} from "../llm/provider/format-model-details.js";
import type { ModelCatalogEntry } from "../llm/provider/model-resolver.js";
import { searchModels } from "../llm/provider/model-search.js";
import { fetchOpenAiCompatModels } from "../llm/provider/openai/fetch-openai-compat-models.js";
import { fetchGeminiModels } from "../llm/provider/gemini/fetch-gemini-models.js";
import {
  listAimlapiChatPicks,
  refreshAimlapiChatCatalogFromApi,
} from "../llm/provider/aimlapi/fetch-aimlapi-chat-catalog.js";
import {
  listOpenRouterChatPicks,
  refreshOpenRouterChatCatalogFromApi,
} from "../llm/provider/openrouter/fetch-openrouter-chat-catalog.js";
import { resolveLlmConfig } from "../llm/provider/registry/provider-types.js";
import type { LlmProviderConfigEntry } from "../llm/provider/registry/provider-types.js";

/**
 * `atomic-agent models search <query>` — the cloud half of `models`.
 *
 * The rest of this command group manages local GGUF weights. Cloud
 * models were only ever searchable from inside the TUI, which is no
 * help when picking a `defaultChatModel` for a config file or checking
 * what a provider charges. Same scorer as the TUI picker
 * (`searchModels`), same rendering (`format-model-details`), so a query
 * that works in one surface works in the other.
 */

export type ModelSearchHit = {
  providerId: string;
  id: string;
  entry?: ModelCatalogEntry | undefined;
};

/**
 * A live model list that was asked for and did not come back, with the
 * reason in the provider's words. Collected rather than thrown: one
 * provider being down must not fail a search the others can answer.
 */
export type LiveListFailure = {
  providerId: string;
  reason: string;
};

export type ModelsSearchOptions = {
  query: string;
  provider: string | null;
  limit: number;
  json: boolean;
  refresh: boolean;
};

const DEFAULT_LIMIT = 30;

export function parseModelsSearchArgs(
  args: readonly string[],
): ModelsSearchOptions {
  const terms: string[] = [];
  let provider: string | null = null;
  let limit = DEFAULT_LIMIT;
  let json = false;
  let refresh = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json") json = true;
    else if (arg === "--refresh") refresh = true;
    else if (arg === "--provider") provider = args[++i] ?? null;
    else if (arg === "--limit") {
      const raw = Number.parseInt(args[++i] ?? "", 10);
      if (!Number.isFinite(raw) || raw <= 0) {
        throw new Error("--limit expects a positive integer");
      }
      limit = raw;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag: ${arg}`);
    } else terms.push(arg);
  }
  if (provider !== null && provider.length === 0) {
    throw new Error("--provider expects a provider id");
  }
  return { query: terms.join(" "), provider, limit, json, refresh };
}

/**
 * Every model this machine could reach, tagged with the provider entry
 * it came from: the bundled catalog for curated kinds, plus whatever the
 * entry carries under `userModels`.
 *
 * Note that `userModels` cannot currently arrive from `config.json` —
 * `parseLlmProviderEntry` drops the field even though the schema, the
 * `LlmProviderConfigEntry` type and `resolveModel` all support it. This
 * reads whatever the entry actually holds rather than assuming the
 * config parser is the only way one gets populated.
 */
export async function collectHits(
  entries: readonly LlmProviderConfigEntry[],
  refresh: boolean,
  failures: LiveListFailure[] = [],
): Promise<readonly ModelSearchHit[]> {
  const hits: ModelSearchHit[] = [];
  for (const entry of entries) {
    if (refresh) await refreshCatalog(entry);
    const seen = new Set<string>();
    const add = (id: string, catalogEntry?: ModelCatalogEntry): void => {
      if (seen.has(id)) return;
      seen.add(id);
      hits.push({ providerId: entry.id, id, entry: catalogEntry });
    };
    // Bundled snapshot first: it is curated, ordered, and the only
    // source that carries embedding rows.
    for (const [id, catalogEntry] of catalogForProvider(entry))
      add(id, catalogEntry);
    // Then whatever the live picker cache holds. `listXChatPicks` falls
    // back to the same snapshot when nothing has been fetched, so this
    // only ever adds ids — after `--refresh` it is the fresh catalog.
    for (const pick of livePicks(entry)) add(pick.id, pick.entry);
    for (const model of entry.userModels ?? []) add(model.id);
    if (refresh) for (const id of await liveModels(entry, failures)) add(id);
  }
  return hits;
}

/**
 * A live refresh writes into each fetcher's module cache, which is what
 * `catalogForProvider` reads through for curated kinds. Failures are
 * silent on purpose: the bundled snapshot is still a useful answer, and
 * a search should not fail because a vendor endpoint is down.
 */
async function refreshCatalog(entry: LlmProviderConfigEntry): Promise<void> {
  try {
    if (entry.kind === "openrouter")
      await refreshOpenRouterChatCatalogFromApi();
    else if (entry.kind === "aimlapi") await refreshAimlapiChatCatalogFromApi();
  } catch {
    /* keep the bundled snapshot */
  }
}

function livePicks(
  entry: LlmProviderConfigEntry,
): readonly { id: string; entry: ModelCatalogEntry }[] {
  if (entry.kind === "openrouter") return listOpenRouterChatPicks();
  if (entry.kind === "aimlapi") return listAimlapiChatPicks();
  return [];
}

/**
 * The provider's own model list, for the kinds that ship no catalog: the
 * entry's `/v1/models`, or Gemini's `/v1beta/openai/models`. Each request
 * carries the headers the entry's chat requests carry — the entry is the
 * auth description — so a service that does not take `Authorization:
 * Bearer` (Anthropic's `x-api-key`) is asked the way it can answer.
 *
 * A failure lands in `failures` and yields no ids; the caller decides
 * whether it is worth saying.
 */
async function liveModels(
  entry: LlmProviderConfigEntry,
  failures: LiveListFailure[],
): Promise<readonly string[]> {
  if (entry.kind === "gemini") {
    // Google lists its models only for a key: without one the route
    // answers 404 "Requested entity was not found", which reads as a
    // wrong URL rather than as the missing key it is.
    if (!entry.apiKey) {
      failures.push({ providerId: entry.id, reason: missingKeyReason(entry) });
      return [];
    }
    return listOrRecord(entry, failures, () => fetchGeminiModels(entry.apiKey));
  }
  if (!entry.baseUrl) return [];
  if (
    entry.kind !== "openai-compatible" &&
    entry.kind !== "qwen-openai-compatible"
  ) {
    return [];
  }
  const baseUrl = entry.baseUrl;
  return listOrRecord(entry, failures, () =>
    fetchOpenAiCompatModels(baseUrl, entry.apiKey, entry),
  );
}

async function listOrRecord(
  entry: LlmProviderConfigEntry,
  failures: LiveListFailure[],
  list: () => Promise<readonly string[]>,
): Promise<readonly string[]> {
  try {
    return await list();
  } catch (err) {
    failures.push({
      providerId: entry.id,
      reason: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Names the variable the key would come from, as `resolveLlmProviderApiKey` reads it. */
function missingKeyReason(entry: LlmProviderConfigEntry): string {
  // The runtime entry is the file entry spread (`mapUserLlmToRuntime`),
  // so a preset's own variable is on it even though this type omits it.
  const named = (entry as { apiKeyEnvVar?: unknown }).apiKeyEnvVar;
  const envVar =
    typeof named === "string" && named.length > 0 ? named : "GEMINI_API_KEY";
  return `no API key — set ${envVar}`;
}

function formatHit(hit: ModelSearchHit): string {
  const entry = hit.entry;
  const details = entry
    ? [
        formatContextWindow(entry.contextWindow),
        formatTokenPrice(hit.id, entry.pricing),
        formatCapabilitySummary(entry),
      ].join(" · ")
    : "metadata unavailable";
  return `${hit.providerId.padEnd(14)} ${hit.id.padEnd(42)} ${details}`;
}

export async function runModelsSearch(
  args: readonly string[],
): Promise<number> {
  let options: ModelsSearchOptions;
  try {
    options = parseModelsSearchArgs(args);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
  if (options.query.length === 0) {
    process.stderr.write(
      "models search expects a query, e.g. `models search claude vision`\n",
    );
    return 1;
  }

  const resolved = resolveLlmConfig(getConfig());
  const entries = resolved.providers.filter((entry) =>
    options.provider === null ? true : entry.id === options.provider,
  );
  if (options.provider !== null && entries.length === 0) {
    process.stderr.write(
      `no configured provider with id "${options.provider}"\n`,
    );
    return 1;
  }

  const failures: LiveListFailure[] = [];
  const hits = await collectHits(entries, options.refresh, failures);
  if (hits.length === 0 && failures.length > 0) {
    // The live list was the whole answer and it did not come back. Say
    // why, in the provider's words, rather than "ships no catalog": the
    // desktop's model step shows this line under the key it just took.
    for (const failure of failures) {
      process.stderr.write(
        `could not list models from ${JSON.stringify(failure.providerId)}: ${failure.reason}\n`,
      );
    }
    return 1;
  }
  if (hits.length === 0) {
    process.stderr.write(
      "no searchable cloud models: the configured providers ship no catalog. " +
        "Add an openrouter or aimlapi provider, or re-run with --refresh to " +
        "pull a live /v1/models list.\n",
    );
    return 1;
  }

  const matches = searchModels(hits, options.query).slice(0, options.limit);
  if (matches.length === 0) {
    process.stderr.write(`no model matches ${JSON.stringify(options.query)}\n`);
    return 1;
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        matches.map((hit) => ({
          provider: hit.providerId,
          id: hit.id,
          ...(hit.entry
            ? {
                kind: hit.entry.kind,
                contextWindow: hit.entry.contextWindow,
                supportsVision: hit.entry.supportsVision,
                supportsTools: hit.entry.supportsTools,
                supportsPromptCache: hit.entry.supportsPromptCache,
                ...(hit.entry.pricing ? { pricing: hit.entry.pricing } : {}),
              }
            : {}),
        })),
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  process.stdout.write(`${matches.map(formatHit).join("\n")}\n`);
  return 0;
}
