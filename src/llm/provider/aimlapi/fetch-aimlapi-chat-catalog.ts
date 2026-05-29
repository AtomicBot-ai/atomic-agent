import type { ModelCatalogEntry } from "../model-resolver.js";
import {
  AIMLAPI_CHAT_MODEL_ORDER,
  AIMLAPI_MODELS_CATALOG,
} from "./aimlapi-models-catalog.js";

const MODELS_URL = "https://api.aimlapi.com/v1/models";
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_PICKS = 32;

type AimlapiApiModel = {
  id?: string;
  type?: string;
  features?: readonly string[];
  info?: {
    contextLength?: number;
    context_length?: number;
    name?: string;
  };
};

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

function readToolSupport(
  m: AimlapiApiModel,
): "none" | "basic" | "parallel" {
  const features = m.features ?? [];
  const hasFn = features.some((f) => f.includes(".function"));
  const hasParallel = features.some((f) => f.includes("parallel-tool-calls"));
  if (hasParallel) return "parallel";
  if (hasFn) return "basic";
  return "none";
}

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

function picksFromStaticCatalog(): readonly AimlapiChatPick[] {
  const out: AimlapiChatPick[] = [];
  for (const id of AIMLAPI_CHAT_MODEL_ORDER) {
    const entry = AIMLAPI_MODELS_CATALOG.get(id);
    if (!entry || entry.kind !== "chat") continue;
    out.push({ id, label: labelForPick(id, entry), entry });
  }
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
 * Filters to rows where `type === "chat-completion"` and the model
 * advertises a `*.function` feature (the agent loop relies on tool
 * calling). Models with `type === "responses"` (e.g. `openai/o3-pro`)
 * are intentionally excluded — they live on `/v1/responses` and 404 on
 * `/v1/chat/completions`.
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
      if (typeof m.id !== "string") continue;
      if (m.type !== "chat-completion") continue;
      if (readToolSupport(m) === "none") continue;
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

    for (const [id, live] of liveById) {
      if (seen.has(id)) continue;
      if (picks.length >= MAX_PICKS) break;
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
