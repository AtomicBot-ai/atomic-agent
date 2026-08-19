import {
  formatContextWindow,
  formatTokenPrice,
} from "./format-model-details.js";
import type { ModelCatalogEntry } from "./model-resolver.js";

/**
 * Ranked, multi-term search over model ids and their catalog metadata.
 *
 * The picker used to filter with one case-insensitive `includes` over
 * the id, which is fine for 18 rows and useless for the 300-400 the
 * live OpenRouter catalog returns: "the cheap Claude with vision" is
 * not a substring of anything. Here a query is split into terms, every
 * term has to match (AND), and a term may match the id, the vendor, or
 * a capability tag derived from the catalog entry — so `claude vision`,
 * `1m cache` and `free tools` all narrow the list.
 *
 * Matches are ranked, best first, and equal ranks keep input order: the
 * bundled catalogs are hand-ordered and the picker re-runs this on
 * every keystroke, so rows must not jitter between presses.
 */

export type ModelSearchItem = {
  readonly id: string;
  readonly entry?: ModelCatalogEntry | undefined;
};

/** Metadata lookup for callers that hold ids and a catalog separately. */
export type ModelEntryLookup = (id: string) => ModelCatalogEntry | undefined;

/**
 * Per-term match strength. Summed across terms into the row score, so a
 * row matching one term exactly and another loosely still outranks a row
 * that matches both loosely.
 */
const RANK = {
  exactId: 6,
  idPrefix: 5,
  vendor: 4,
  wordStart: 3,
  substring: 2,
  tag: 2,
  subsequence: 1,
  none: 0,
} as const;

export function splitQueryTerms(query: string): readonly string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Searchable tags for a row: what an operator would type that is not
 * part of the id. Everything here is derived from the catalog entry, so
 * a row without metadata simply has fewer ways to be found.
 */
export function modelSearchTags(
  entry: ModelCatalogEntry | undefined,
  modelId?: string,
): readonly string[] {
  if (!entry) return [];
  const tags: string[] = [entry.kind];
  tags.push(entry.supportsVision ? "vision" : "text");
  if (entry.supportsTools !== "none") tags.push("tools");
  if (entry.supportsPromptCache) tags.push("cache");
  if (entry.contextWindow > 0) {
    tags.push(formatContextWindow(entry.contextWindow).toLowerCase());
  }
  // Price tags mirror what the row displays, so searching for what you
  // can see works: `openrouter/auto` renders as "routed", not "free",
  // even though its list price is zero.
  const priceLabel = formatTokenPrice(modelId ?? entry.id, entry.pricing);
  if (priceLabel === "free" || priceLabel === "routed") tags.push(priceLabel);
  else if (entry.pricing && entry.pricing.input > 0 && entry.pricing.input < 1) {
    tags.push("cheap");
  }
  return tags;
}

function rankTerm(
  term: string,
  id: string,
  vendor: string,
  tags: readonly string[],
): number {
  if (id === term) return RANK.exactId;
  if (id.startsWith(term)) return RANK.idPrefix;
  if (vendor === term || vendor.startsWith(term)) return RANK.vendor;
  const at = id.indexOf(term);
  if (at >= 0) {
    // A term that starts a word ("opus" in "claude-opus-5") is a better
    // hit than one buried mid-token ("pus").
    const before = at === 0 ? "" : id[at - 1]!;
    return at === 0 || /[^a-z0-9]/.test(before) ? RANK.wordStart : RANK.substring;
  }
  if (tags.includes(term)) return RANK.tag;
  return isSubsequence(term, id) ? RANK.subsequence : RANK.none;
}

/** Typo tolerance: every character of `term`, in order, somewhere in `id`. */
function isSubsequence(term: string, id: string): boolean {
  let i = 0;
  for (const ch of id) {
    if (ch === term[i]) i += 1;
    if (i === term.length) return true;
  }
  return term.length === 0;
}

export function scoreModel(
  item: ModelSearchItem,
  terms: readonly string[],
): number {
  const id = item.id.toLowerCase();
  const slash = id.indexOf("/");
  const vendor = slash > 0 ? id.slice(0, slash) : "";
  const tags = modelSearchTags(item.entry, item.id);
  let total = 0;
  for (const term of terms) {
    const rank = rankTerm(term, id, vendor, tags);
    // AND semantics: one unmatched term drops the row entirely.
    if (rank === RANK.none) return RANK.none;
    total += rank;
  }
  return total;
}

/**
 * Rows matching `query`, best match first. An empty query returns
 * `items` untouched — the caller renders the full catalog.
 */
export function searchModels<T extends ModelSearchItem>(
  items: readonly T[],
  query: string,
): readonly T[] {
  const terms = splitQueryTerms(query);
  if (terms.length === 0) return items;
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const score = scoreModel(item, terms);
    if (score > 0) scored.push({ item, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((row) => row.item);
}

/** `searchModels` for callers that hold plain ids plus an optional catalog. */
export function searchModelIds(
  ids: readonly string[],
  query: string,
  lookup?: ModelEntryLookup,
): readonly string[] {
  const terms = splitQueryTerms(query);
  if (terms.length === 0) return ids;
  const items = ids.map((id) => ({ id, entry: lookup?.(id) }));
  return searchModels(items, query).map((item) => item.id);
}
