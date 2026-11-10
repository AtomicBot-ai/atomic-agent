import type { ModelCatalogEntry } from "../model-resolver.js";
import {
  describeCatalogFetchError,
  type CatalogRefreshResult,
} from "../catalog-refresh-result.js";
import {
  OPENROUTER_CHAT_MODEL_ORDER,
  OPENROUTER_MODELS_CATALOG,
} from "./openrouter-models-catalog.js";
import { compareChatRows, pricePerMillion, scoreChat } from "./openrouter-chat-score.js";

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 60 * 60 * 1000;

type OpenRouterApiModel = {
  id?: string;
  name?: string;
  context_length?: number;
  /** Unix seconds the model was listed; the tiebreak in `compareChatRows`. */
  created?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[] };
};

export type OpenRouterChatPick = {
  id: string;
  label: string;
  entry: ModelCatalogEntry;
};

let cached: { fetchedAt: number; picks: readonly OpenRouterChatPick[] } | null =
  null;
/** Stated image support per id from the cached fetch; see `getAdvertisedOpenRouterVision`. */
let advertisedVision: ReadonlyMap<string, boolean> = new Map();

function apiRowToEntry(m: OpenRouterApiModel): ModelCatalogEntry {
  const id = m.id!;
  // Unlike tools, silence deliberately reads as "no vision", and that is
  // a capability decision, not a cosmetic one: `supportsVision` gates
  // `vision.describe` through `ProviderCapabilities.vision`, so a row
  // without `input_modalities` loses image input for that id. Still the
  // safer default: overclaiming breaks at request time with a rejected
  // image payload, while underclaiming keeps the model usable for text
  // and can never empty the catalog.
  const vision = (m.architecture?.input_modalities ?? []).includes("image");
  return {
    id,
    kind: "chat",
    contextWindow: m.context_length ?? 128_000,
    supportsVision: vision,
    supportsTools: "parallel",
    supportsPromptCache: false,
    reasoningFormat: "none",
    pricing: {
      input: pricePerMillion(m.pricing?.prompt),
      output: pricePerMillion(m.pricing?.completion),
    },
  };
}

function labelForPick(
  id: string,
  entry: ModelCatalogEntry,
  name?: string,
): string {
  if (id === "openrouter/auto") {
    return "recommended · OpenRouter Auto (picks route)";
  }
  const price =
    entry.pricing && (entry.pricing.input > 0 || entry.pricing.output > 0)
      ? ` · $${entry.pricing.input}/${entry.pricing.output} per 1M`
      : "";
  const short = name ? ` · ${name.replace(/^[^:]+:\s*/, "").slice(0, 36)}` : "";
  return `${id}${short}${price}`;
}

let staticPicks: readonly OpenRouterChatPick[] | null = null;

function picksFromStaticCatalog(): readonly OpenRouterChatPick[] {
  // Memoized: downstream lookup caches key themselves on the array
  // reference (see providers-model-options), so the offline fallback must
  // return a stable array rather than a fresh one per call.
  if (staticPicks) return staticPicks;
  const out: OpenRouterChatPick[] = [];
  for (const id of OPENROUTER_CHAT_MODEL_ORDER) {
    const entry = OPENROUTER_MODELS_CATALOG.get(id);
    if (!entry || entry.kind !== "chat") continue;
    out.push({
      id,
      label: labelForPick(id, entry),
      entry,
    });
  }
  staticPicks = out;
  return out;
}

export function getCachedOpenRouterChatPicks():
  readonly OpenRouterChatPick[] | null {
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) return null;
  return cached.picks;
}

/**
 * What the last live fetch said about image input for `id`: `true` /
 * `false` when the row carried `architecture.input_modalities`,
 * `undefined` when it said nothing, the id was not listed, or the cache
 * is cold or stale. Unlike the pick's `supportsVision` (where silence
 * reads as "no"), this keeps silence apart, so the provider layer can
 * treat an unstated model as unknown rather than text-only
 * (`model-vision.ts`).
 */
export function getAdvertisedOpenRouterVision(id: string): boolean | undefined {
  if (!cached || Date.now() - cached.fetchedAt > CACHE_TTL_MS) return undefined;
  return advertisedVision.get(id);
}

export function listOpenRouterChatPicks(): readonly OpenRouterChatPick[] {
  return getCachedOpenRouterChatPicks() ?? picksFromStaticCatalog();
}

let inFlight: Promise<CatalogRefreshResult> | null = null;

/**
 * Pull the public OpenRouter model list and rebuild the TUI picker
 * (every `tools`-capable chat model OpenRouter advertises). Falls back to
 * the static catalog on network/parse errors.
 *
 * Concurrent callers share one request: the TUI triggers this from both
 * the panel prefetch and the wizard's picker step, and doubling the
 * fetch would only race two writers over the same module cache.
 */
export function refreshOpenRouterChatCatalogFromApi(): Promise<boolean> {
  return refreshOpenRouterChatCatalog().then((result) => result.ok);
}

/**
 * Same refresh, with the reason when it falls back to the static catalog,
 * for a caller that logs why the live list did not load.
 */
export function refreshOpenRouterChatCatalog(): Promise<CatalogRefreshResult> {
  if (inFlight) return inFlight;
  const request = fetchAndCacheCatalog().finally(() => {
    inFlight = null;
  });
  inFlight = request;
  return request;
}

async function fetchAndCacheCatalog(): Promise<CatalogRefreshResult> {
  try {
    const res = await fetch(MODELS_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const json = (await res.json()) as {
      data?: (OpenRouterApiModel | null)[];
    };
    // A single null or scalar row must not throw and drag the whole live
    // catalog into the static fallback.
    const rows = (json.data ?? []).filter(
      (m): m is OpenRouterApiModel => !!m && typeof m === "object",
    );
    const ranked = rows
      .filter((m) => scoreChat(m) >= 0)
      .sort(compareChatRows);

    const seen = new Set<string>();
    const picks: OpenRouterChatPick[] = [];

    const auto = rows.find((m) => m.id === "openrouter/auto");
    if (auto?.id) {
      const entry = apiRowToEntry(auto);
      picks.push({
        id: auto.id,
        label: labelForPick(auto.id, entry, auto.name),
        entry,
      });
      seen.add(auto.id);
    }

    // Everything OpenRouter advertises, not a truncated head: the picker
    // filters by typed text, so a long list costs nothing while a capped
    // one silently hides most of the catalog (#62 follow-up). `ranked`
    // keeps the score order, so the useful models still come first.
    for (const m of ranked) {
      if (!m.id || seen.has(m.id)) continue;
      const entry = apiRowToEntry(m);
      picks.push({
        id: m.id,
        label: labelForPick(m.id, entry, m.name),
        entry,
      });
      seen.add(m.id);
    }

    if (picks.length === 0) {
      return { ok: false, reason: `no usable chat models in ${rows.length} rows` };
    }
    const stated = new Map<string, boolean>();
    for (const m of rows) {
      const modalities = m.architecture?.input_modalities;
      if (typeof m.id === "string" && Array.isArray(modalities)) {
        stated.set(m.id, modalities.includes("image"));
      }
    }
    advertisedVision = stated;
    cached = { fetchedAt: Date.now(), picks };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: describeCatalogFetchError(err, FETCH_TIMEOUT_MS) };
  }
}
