import { isLocalServerUrl } from "../llm/provider/openai/local-server-url.js";
import { modelsDevCatalogEntry } from "../llm/provider/models-dev/models-dev-catalog.js";
import { modelsDevProviderFor } from "../llm/provider/models-dev/models-dev-ids.js";
import { MODELS_DEV_SNAPSHOT, type ModelsDevRow } from "../llm/provider/models-dev/models-dev-snapshot.js";
import type { LlmProviderConfigEntry } from "../llm/provider/registry/provider-types.js";
import { estimateUsageCostUsd } from "../llm/provider/usage-cost.js";
import type { UsageHistoryRow } from "./usage-history-types.js";

/**
 * "Saved by local" (ATO-2442): what the tokens a local model served
 * would have cost at a cloud model's list price. An estimate, and
 * labelled so everywhere: the same work on another model would not
 * take the same tokens. Prices come from the models.dev snapshot built
 * into the agent, so it never needs the network; a model with no price
 * there reads as "unknown", never as $0.
 *
 * The reference model, in order: the one asked for (`--compare`,
 * `?compare=`); else the operator's own cloud model, the active one
 * first, when the snapshot prices it; else a cheap, widely used cloud
 * model, so the figure leans low rather than flattering.
 */
export type ReferenceSource = "compare" | "configured" | "default";

export interface ReferenceModel {
  /** models.dev provider slug, e.g. `deepseek`. */
  provider: string;
  model: string;
  source: ReferenceSource;
  pricing: { input: number; output: number; cacheRead?: number };
}

export type SavedByLocal =
  | {
      status: "estimate";
      usd: number;
      reference: Omit<ReferenceModel, "pricing"> & { inputPerMTok: number; outputPerMTok: number };
      localInputTokens: number;
      localOutputTokens: number;
      localCachedTokens: number;
    }
  /** Local tokens, but no price for the reference model (a `--compare` model the snapshot does not list). */
  | { status: "unknown"; requested: string | null; localInputTokens: number; localOutputTokens: number }
  /** No local tokens in the window: nothing was saved, nothing to estimate. */
  | { status: "none" };

/** The fallback references, cheapest widely used first; the first the snapshot prices wins. */
export const DEFAULT_REFERENCE_MODELS: readonly { provider: string; model: string }[] = [
  { provider: "deepseek", model: "deepseek-v4-flash" },
  { provider: "google", model: "gemini-flash-lite-latest" },
];

type Snapshot = Readonly<Record<string, Readonly<Record<string, ModelsDevRow>>>>;

export interface ReferenceInputs {
  /** `--compare` / `?compare=`: `provider/model`, a configured provider id `/model`, or a bare model id. */
  compare?: string | null;
  providers?: readonly LlmProviderConfigEntry[];
  activeTextProvider?: string;
  snapshot?: Snapshot;
}

/** The reference model, or `null` when the one asked for has no known price. */
export function resolveReferenceModel(inputs: ReferenceInputs): ReferenceModel | null {
  const snapshot = inputs.snapshot ?? MODELS_DEV_SNAPSHOT;
  const compare = inputs.compare?.trim();
  if (compare) return compareModel(compare, inputs.providers ?? [], snapshot);
  const configured = configuredModel(inputs.providers ?? [], inputs.activeTextProvider, snapshot);
  if (configured) return configured;
  for (const d of DEFAULT_REFERENCE_MODELS) {
    const found = rowIn(snapshot, d.provider, d.model);
    if (found) return { ...found, source: "default" };
  }
  return null;
}

/** Local rows priced at `reference`; `reference === null` means no price was found. */
export function estimateSavedByLocal(
  rows: readonly UsageHistoryRow[],
  reference: ReferenceModel | null,
  requested: string | null = null,
): SavedByLocal {
  const local = rows.filter((r) => r.billing === "local");
  const input = local.reduce((n, r) => n + r.inputTokens, 0);
  const output = local.reduce((n, r) => n + r.outputTokens, 0);
  const cached = local.reduce((n, r) => n + Math.min(r.cachedTokens, r.inputTokens), 0);
  if (input + output === 0) return { status: "none" };
  if (reference === null) return { status: "unknown", requested, localInputTokens: input, localOutputTokens: output };
  const usd = estimateUsageCostUsd(
    { promptTokens: input, completionTokens: output, totalTokens: input + output, cachedTokens: cached },
    reference.pricing,
  );
  if (!Number.isFinite(usd)) return { status: "unknown", requested, localInputTokens: input, localOutputTokens: output };
  const { pricing, ...named } = reference;
  return {
    status: "estimate",
    usd,
    reference: { ...named, inputPerMTok: pricing.input, outputPerMTok: pricing.output },
    localInputTokens: input,
    localOutputTokens: output,
    localCachedTokens: cached,
  };
}

function compareModel(
  compare: string,
  providers: readonly LlmProviderConfigEntry[],
  snapshot: Snapshot,
): ReferenceModel | null {
  const slash = compare.indexOf("/");
  if (slash > 0) {
    const head = compare.slice(0, slash);
    const tail = compare.slice(slash + 1);
    const direct = rowIn(snapshot, head, tail);
    if (direct) return { ...direct, source: "compare" };
    const entry = providers.find((p) => p.id === head);
    const viaEntry = entry ? priceOfEntry(entry, tail, snapshot) : null;
    if (viaEntry) return { ...viaEntry, source: "compare" };
  }
  // A bare id, or one with slashes of its own (`accounts/fireworks/models/x`): any provider.
  for (const provider of Object.keys(snapshot).sort()) {
    const found = rowIn(snapshot, provider, compare);
    if (found) return { ...found, source: "compare" };
  }
  return null;
}

function configuredModel(
  providers: readonly LlmProviderConfigEntry[],
  activeId: string | undefined,
  snapshot: Snapshot,
): ReferenceModel | null {
  const ordered = [...providers].sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId));
  for (const entry of ordered) {
    if (entry.kind === "llama-server" || entry.kind.startsWith("subscription-")) continue;
    if (isLocalServerUrl(entry.baseUrl ?? entry.url)) continue;
    const model = entry.model ?? entry.defaultChatModel;
    if (!model) continue;
    const found = priceOfEntry(entry, model, snapshot);
    if (found) return { ...found, source: "configured" };
  }
  return null;
}

function priceOfEntry(
  entry: LlmProviderConfigEntry,
  model: string,
  snapshot: Snapshot,
): Omit<ReferenceModel, "source"> | null {
  const slug = modelsDevProviderFor(entry);
  const pricing = modelsDevCatalogEntry(entry, model, snapshot)?.pricing;
  if (slug === undefined || !pricing || !(pricing.input >= 0) || !(pricing.output >= 0)) return null;
  return { provider: slug, model, pricing: pickPricing(pricing) };
}

function rowIn(snapshot: Snapshot, provider: string, model: string): Omit<ReferenceModel, "source"> | null {
  const models = Object.hasOwn(snapshot, provider) ? snapshot[provider] : undefined;
  if (!models) return null;
  const id = Object.hasOwn(models, model)
    ? model
    : Object.keys(models).find((m) => m.toLowerCase() === model.toLowerCase());
  const cost = id === undefined ? undefined : models[id]?.cost;
  if (id === undefined || !cost) return null;
  return { provider, model: id, pricing: pickPricing(cost) };
}

function pickPricing(p: { input: number; output: number; cacheRead?: number }): ReferenceModel["pricing"] {
  return { input: p.input, output: p.output, ...(p.cacheRead !== undefined ? { cacheRead: p.cacheRead } : {}) };
}
