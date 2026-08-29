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
  if (entry.contextWindow > 0) tags.push(...contextWindowTags(entry.contextWindow));
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

/**
 * Every shorthand an operator would type for one context window.
 *
 * The display string alone is not enough, because it is a rounded
 * decimal rendering and tag matching is exact: `formatContextWindow`
 * writes 1_048_576 as "1.0m" and 131_072 as "131k", so `1m` and `128k` —
 * the numbers those vendors actually advertise — would drop the row.
 * The formatter stays as it is; the extra forms ride alongside it.
 *
 * Three forms per window, deduped:
 *
 * 1. the display string, so searching for what the row shows works;
 * 2. the whole-unit **floor** in that same unit — 1_310_720 -> `1m`,
 *    1_050_000 -> `1m`, 202_752 -> `202k`. Floor rather than round,
 *    because a size term names the bucket a window falls in: `1m` means
 *    "a window in the millions", so it must find every row from 1M up to
 *    2M — a 2M row answers to `2m`, not to `1m` — and must not find a
 *    950k row that would round up to it;
 * 3. the **binary** reading, when the window is an exact multiple of
 *    1024 (1024² above a million) — 131_072 -> `128k`, 204_800 ->
 *    `200k`, 262_144 -> `256k`, 1_048_576 -> `1m`. Those windows are
 *    power-of-two sized and are sold by the binary number; decimal
 *    rounding is what hides it. The exact-multiple guard keeps the
 *    reading off windows that were never binary (200_000 stays `200k`).
 *
 * Raw token counts (`131072`) are deliberately not tags: no surface
 * renders one, so nobody reads it off a row to type it back.
 */
function contextWindowTags(tokens: number): readonly string[] {
  const tags = [formatContextWindow(tokens).toLowerCase()];
  const add = (tag: string): void => {
    if (!tags.includes(tag)) tags.push(tag);
  };
  if (tokens >= 1_000_000) {
    add(`${Math.floor(tokens / 1_000_000)}m`);
    if (tokens % 1_048_576 === 0) add(`${tokens / 1_048_576}m`);
  } else if (tokens >= 1_000) {
    add(`${Math.floor(tokens / 1_000)}k`);
    if (tokens % 1_024 === 0) add(`${tokens / 1_024}k`);
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
