import type { ModelCatalogEntry } from "../model-resolver.js";
import {
  OPENROUTER_CHAT_MODEL_ORDER,
  OPENROUTER_MODELS_CATALOG,
} from "./openrouter-models-catalog.js";

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_PICKS = 12;

type OpenRouterApiModel = {
  id?: string;
  name?: string;
  context_length?: number;
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

function pricePerMillion(tokenPrice: string | undefined): number {
  const n = parseFloat(tokenPrice ?? "0");
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 1_000_000 * 100) / 100;
}

function hasTools(m: OpenRouterApiModel): boolean {
  return Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools");
}

function scoreChat(m: OpenRouterApiModel): number {
  const id = m.id ?? "";
  if (!id || id.startsWith("anthropic/")) return -1;
  if (/qwen3\.5/i.test(id)) return -1;
  if (/embed|rerank|moderation|ocr|tts|transcribe/i.test(id)) return -1;
  if (!hasTools(m)) return -1;
  let s = 10;
  const ctx = m.context_length ?? 0;
  if (ctx >= 1_000_000) s += 8;
  else if (ctx >= 200_000) s += 5;
  if (/qwen3\.7|qwen3\.6/i.test(id)) s += 20;
  if (/gpt-5\./i.test(id)) s += 15;
  if (/gemini-3\.|gemini-2\.5/i.test(id)) s += 12;
  if (/deepseek.*v4|deepseek.*v3/i.test(id)) s += 10;
  if (/kimi-k2\.6/i.test(id)) s += 12;
  else if (/kimi-k2/i.test(id)) s += 8;
  if (/z-ai\/glm-5|z-ai\/glm-4\.7-flash/i.test(id)) s += 11;
  else if (/z-ai\/glm/i.test(id)) s += 7;
  if (/4o-mini|3\.5-turbo/i.test(id)) s -= 8;
  if (/thinking|reasoner|r1/i.test(id)) s -= 5;
  const pin = pricePerMillion(m.pricing?.prompt);
  if (pin > 0 && pin < 1) s += 3;
  return s;
}

function apiRowToEntry(m: OpenRouterApiModel): ModelCatalogEntry {
  const id = m.id!;
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

function labelForPick(id: string, entry: ModelCatalogEntry, name?: string): string {
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

function picksFromStaticCatalog(): readonly OpenRouterChatPick[] {
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
  return out;
}

export function getCachedOpenRouterChatPicks(): readonly OpenRouterChatPick[] | null {
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) return null;
  return cached.picks;
}

export function listOpenRouterChatPicks(): readonly OpenRouterChatPick[] {
  return getCachedOpenRouterChatPicks() ?? picksFromStaticCatalog();
}

/**
 * Pull the public OpenRouter model list and rebuild the TUI picker
 * (non-Anthropic, `tools`-capable chat models). Falls back to the static
 * catalog on network/parse errors.
 */
export async function refreshOpenRouterChatCatalogFromApi(): Promise<boolean> {
  try {
    const res = await fetch(MODELS_URL, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { data?: OpenRouterApiModel[] };
    const rows = json.data ?? [];
    const ranked = rows
      .filter((m) => scoreChat(m) >= 0)
      .sort((a, b) => scoreChat(b) - scoreChat(a));

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

    for (const m of ranked) {
      if (!m.id || seen.has(m.id)) continue;
      if (picks.length >= MAX_PICKS) break;
      const entry = apiRowToEntry(m);
      picks.push({
        id: m.id,
        label: labelForPick(m.id, entry, m.name),
        entry,
      });
      seen.add(m.id);
    }

    if (picks.length === 0) return false;
    cached = { fetchedAt: Date.now(), picks };
    return true;
  } catch {
    return false;
  }
}
