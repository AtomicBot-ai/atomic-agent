import { formatTokenPrice } from "./format-model-details.js";
import type { ModelCatalogEntry } from "./model-resolver.js";
import type { ModelEntryLookup } from "./model-search.js";

/**
 * The price facet of the cloud model pickers: `all` shows the whole
 * catalog, `free` only the rows whose price tag reads "free", `paid`
 * the rest.
 *
 * `free` is deliberately strict — a row stays only when the catalog
 * proves both prices are zero, by the same `formatTokenPrice` rule that
 * paints the "free" tag on the row, so the facet can never contradict
 * what a row says about itself. Everything else is `paid`: rows with
 * real prices, `openrouter/auto` (renders "routed" — it bills whatever
 * model it picks), and rows with no pricing metadata at all (aimlapi,
 * live `/v1/models` ids), which cannot be promised to cost nothing.
 * The two facets partition the catalog, so no row ever vanishes from
 * both views.
 */
export type ModelPricingFilter = "all" | "free" | "paid";

/** Cycle order for the one-key toggle; `all` first because it is the default. */
const PRICING_CYCLE: readonly ModelPricingFilter[] = ["all", "free", "paid"];

export function nextModelPricingFilter(
  current: ModelPricingFilter,
): ModelPricingFilter {
  const at = PRICING_CYCLE.indexOf(current);
  return PRICING_CYCLE[(at + 1) % PRICING_CYCLE.length] ?? "all";
}

/** `true` when the row's rendered price tag reads "free" — see the type note. */
export function isFreeModelEntry(
  modelId: string,
  entry: ModelCatalogEntry | undefined,
): boolean {
  if (!entry?.pricing) return false;
  return formatTokenPrice(modelId, entry.pricing) === "free";
}

export function matchesModelPricingFilter(
  filter: ModelPricingFilter,
  modelId: string,
  entry: ModelCatalogEntry | undefined,
): boolean {
  if (filter === "all") return true;
  return isFreeModelEntry(modelId, entry) === (filter === "free");
}

/**
 * `ids` narrowed to the facet. `all` returns the input array itself so
 * the no-facet path costs nothing on a 350-row catalog rebuilt per
 * keystroke (same discipline as `filterWizardRows`).
 */
export function filterIdsByPricing(
  ids: readonly string[],
  filter: ModelPricingFilter,
  lookup: ModelEntryLookup | undefined,
): readonly string[] {
  if (filter === "all") return ids;
  return ids.filter((id) => matchesModelPricingFilter(filter, id, lookup?.(id)));
}
