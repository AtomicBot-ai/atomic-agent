import type { ModelCatalogEntry } from "../model-resolver.js";
import {
  AIMLAPI_CHAT_MODEL_ORDER,
  AIMLAPI_MODELS_CATALOG,
} from "./aimlapi-models-catalog.js";

const MODELS_URL = "https://api.aimlapi.com/v1/models";
const CACHE_TTL_MS = 60 * 60 * 1000;

type AimlapiApiModel = {
  id?: string;
  type?: string;
  /**
   * Capability flags. Present in the pre-2026-08 response shape; the
   * current API dropped the field entirely, so every reader must treat
   * it as optional rather than assuming its absence means "no support".
   *
   * The current shape's `tags` array is deliberately NOT modelled here:
   * as of 2026-08 it only carries playground grouping and pricing tier
   * labels (`playground:chat`, `tier:tier_2`), never capability
   * markers (the gpt-4o family shows up without any vision tag), so
   * nothing can be derived from it.
   */
  features?: readonly string[];
  info?: {
    contextLength?: number;
    context_length?: number;
    name?: string;
  };
};

/**
 * Chat rows have carried two different `type` spellings: `chat-completion`
 * (pre-2026-08) and `openai/chat-completions` (current, vendor-prefixed).
 * Matching on the suffix keeps both working and survives the next
 * renaming of the same idea, while still excluding the other families in
 * the same response: video generations, image generations,
 * `anthropic/messages`, and the `responses/submit` family.
 */
function isChatCompletionType(type: string | undefined): boolean {
  if (typeof type !== "string") return false;
  const normalized = type.toLowerCase();
  return (
    normalized === "chat-completion" ||
    normalized === "chat-completions" ||
    normalized.endsWith("/chat-completions") ||
    normalized.endsWith("/chat-completion")
  );
}

export type AimlapiChatPick = {
  id: string;
  label: string;
  entry: ModelCatalogEntry;
};

let cached: { fetchedAt: number; picks: readonly AimlapiChatPick[] } | null =
  null;

function readContextLength(m: AimlapiApiModel): number {
  return m.info?.contextLength ?? m.info?.context_length ?? 128_000;
}

/**
 * Tool support as advertised by the API.
 *
 * `undefined` means "the response says nothing about it", which is the
 * case for the whole current catalog: the `features` array was removed
 * and nothing replaced it. Callers must not read that silence as "no
 * tools": doing so filtered out all 337 chat models and silently pinned
 * the picker to the offline list.
 */
function readAdvertisedToolSupport(
  m: AimlapiApiModel,
): "none" | "basic" | "parallel" | undefined {
  const features = m.features;
  if (features === undefined || features.length === 0) return undefined;
  const hasFn = features.some((f) => f.includes(".function"));
  const hasParallel = features.some((f) => f.includes("parallel-tool-calls"));
  if (hasParallel) return "parallel";
  if (hasFn) return "basic";
  return "none";
}

/**
 * Effective tool support for building a catalog entry. Falls back to
 * `basic` when the API is silent: aimlapi routes these ids to
 * `/v1/chat/completions`, which is the tool-calling surface, and a model
 * that turns out not to support tools fails loudly at request time
 * rather than being invisible in the picker.
 */
function readToolSupport(m: AimlapiApiModel): "none" | "basic" | "parallel" {
  return readAdvertisedToolSupport(m) ?? "basic";
}

/**
 * Unlike tools, silence deliberately reads as "no vision", and the cost
 * of that is real, not cosmetic. `supportsVision` becomes the
 * capability bit on the synthesised {@link ModelCatalogEntry}, which is
 * what the provider layer reads to gate image input
 * (`ProviderCapabilities.vision`, whose `false` makes `vision.describe`
 * raise `VisionUnsupportedError`), so a live-only id whose row stays
 * silent loses `vision.describe` entirely, not just a "vision" badge in
 * the picker. We still prefer underclaiming: advertising vision on a
 * text-only route breaks at request time with a rejected image payload,
 * while a conservative entry keeps the model usable for text and, unlike
 * the tools case, can never empty the catalog. Curated ids are
 * unaffected (their hand-verified static entry wins in
 * `entryFromLiveModel`), and the current response offers no better
 * signal to read: `features` is gone, `tags` and `info` carry no
 * capability fields (see {@link AimlapiApiModel}).
 */
function readVisionSupport(m: AimlapiApiModel): boolean {
  return (m.features ?? []).some((f) => f.includes(".vision"));
}

function entryFromLiveModel(m: AimlapiApiModel, id: string): ModelCatalogEntry {
  const fromStatic = AIMLAPI_MODELS_CATALOG.get(id);
  if (fromStatic && fromStatic.kind === "chat") {
    return fromStatic;
  }
  return {
    id,
    kind: "chat",
    contextWindow: readContextLength(m),
    supportsVision: readVisionSupport(m),
    supportsTools: readToolSupport(m),
    supportsPromptCache: false,
    reasoningFormat: "none",
  };
}

function labelForPick(id: string, entry: ModelCatalogEntry): string {
  const ctx = formatCtx(entry.contextWindow);
  const vision = entry.supportsVision ? " · vision" : "";
  return `${id} · ${ctx}${vision}`;
}

function formatCtx(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return `${tokens}`;
}

let staticPicks: readonly AimlapiChatPick[] | null = null;

function picksFromStaticCatalog(): readonly AimlapiChatPick[] {
  // Memoized: downstream lookup caches key themselves on the array
  // reference (see providers-model-options), so the offline fallback must
  // return a stable array rather than a fresh one per call.
  if (staticPicks) return staticPicks;
  const out: AimlapiChatPick[] = [];
  for (const id of AIMLAPI_CHAT_MODEL_ORDER) {
    const entry = AIMLAPI_MODELS_CATALOG.get(id);
    if (!entry || entry.kind !== "chat") continue;
    out.push({ id, label: labelForPick(id, entry), entry });
  }
  staticPicks = out;
  return out;
}

export function getCachedAimlapiChatPicks(): readonly AimlapiChatPick[] | null {
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) return null;
  return cached.picks;
}

export function listAimlapiChatPicks(): readonly AimlapiChatPick[] {
  return getCachedAimlapiChatPicks() ?? picksFromStaticCatalog();
}

/**
 * Pull the public aimlapi catalog and rebuild the TUI picker.
 *
 * Keeps rows whose `type` is a chat-completions variant (see
 * {@link isChatCompletionType}) and drops a model only when the API
 * explicitly advertises that it cannot call tools; a missing `features`
 * array is treated as silence, not as "no". Rows on other surfaces
 * (`responses`, `anthropic/messages`, image/video generations) are
 * excluded because they 404 on `/v1/chat/completions`.
 *
 * For ids that exist in {@link AIMLAPI_MODELS_CATALOG}, the static
 * entry wins (we hand-curate pricing/cache flags). For new live ids,
 * we synthesise an entry from `info.contextLength` + `features`.
 *
 * Falls back to the static catalog on network or parse errors.
 */
export async function refreshAimlapiChatCatalogFromApi(): Promise<boolean> {
  try {
    const res = await fetch(MODELS_URL, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { data?: AimlapiApiModel[] };
    const rows = json.data ?? [];

    const liveById = new Map<string, AimlapiApiModel>();
    for (const m of rows) {
      // A single null or scalar row must not throw and drag the whole
      // live catalog into the static fallback.
      if (!m || typeof m !== "object") continue;
      if (typeof m.id !== "string" || m.id.length === 0) continue;
      if (!isChatCompletionType(m.type)) continue;
      // Only drop a model when the API explicitly says it cannot call
      // tools. Silence is not a "no" (see `readAdvertisedToolSupport`).
      if (readAdvertisedToolSupport(m) === "none") continue;
      liveById.set(m.id, m);
    }

    const seen = new Set<string>();
    const picks: AimlapiChatPick[] = [];

    for (const id of AIMLAPI_CHAT_MODEL_ORDER) {
      const live = liveById.get(id);
      if (!live) continue;
      const entry = entryFromLiveModel(live, id);
      if (entry.kind !== "chat") continue;
      picks.push({ id, label: labelForPick(id, entry), entry });
      seen.add(id);
    }

    // Everything the provider advertises, not a truncated head: the
    // picker filters by typed text, so a long list costs nothing while a
    // capped one silently hides most of the catalog (#62 follow-up).
    // Curated ids above keep their hand-picked order; the rest follow
    // alphabetically so the tail is predictable.
    const rest = [...liveById.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [id, live] of rest) {
      if (seen.has(id)) continue;
      const entry = entryFromLiveModel(live, id);
      if (entry.kind !== "chat") continue;
      picks.push({ id, label: labelForPick(id, entry), entry });
      seen.add(id);
    }

    if (picks.length === 0) return false;
    cached = { fetchedAt: Date.now(), picks };
    return true;
  } catch {
    return false;
  }
}
