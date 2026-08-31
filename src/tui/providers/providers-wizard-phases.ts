import {
  matchesModelPricingFilter,
  type ModelPricingFilter,
} from "../../llm/provider/model-pricing-filter.js";
import { findProviderPreset, PROVIDER_PRESETS } from "./provider-presets.js";
import {
  filterWizardRows,
  type WizardFilterRow,
} from "./providers-wizard-filter.js";
import { kindRowId, labelForKindRow } from "./providers-wizard-kind-labels.js";
import {
  catalogEntryLookupForKind,
  listAimlapiChatModels,
  listAimlapiEmbeddingModels,
  listOpenRouterChatModels,
  listOpenRouterEmbeddingModels,
} from "./providers-model-options.js";
import {
  subscriptionCliForWizardKind,
  type ProvidersWizardKind,
  type ProvidersWizardPhase,
  type ProvidersWizardState,
} from "./providers-wizard-state.js";

/**
 * Rows on the provider step: the two kinds with built-in catalogs, then
 * every known service as its own row, then the manual escape hatch.
 * Preset rows are not new provider kinds, they resolve to
 * `openai-compatible` with a verified base URL filled in (#69), which is
 * the same flat shape Hermes and OpenClaw present.
 */
export type ProvidersWizardKindRow =
  | ProvidersWizardKind
  | { readonly presetId: string };

/**
 * The single source of row order for `pick_kind`. The render layer
 * derives its labels from this list, so cursor index and label can
 * never disagree.
 */
export const KIND_ROW_ORDER: readonly ProvidersWizardKindRow[] = [
  // Subscription CLIs first: they need no key and no endpoint, so they
  // are the shortest path from a fresh install to a working agent.
  "claude-cli",
  "codex-cli",
  "openrouter",
  "aimlapi",
  "gemini",
  ...PROVIDER_PRESETS.map((preset) => ({ presetId: preset.id })),
  "openai-compatible",
];

/** A `pick_kind` row with the two strings the search box matches on. */
export interface WizardKindOption extends WizardFilterRow {
  readonly row: ProvidersWizardKindRow;
}

/**
 * The provider rows as the screen shows them, in `KIND_ROW_ORDER`.
 * Labels are built here rather than in the component because the key
 * bindings now take Enter's row from a *filtered* list: the two sides
 * can only land on the same row if they filter the same labels.
 */
export const KIND_OPTIONS: readonly WizardKindOption[] = KIND_ROW_ORDER.map(
  (row) => ({ row, id: kindRowId(row), label: labelForKindRow(row) }),
);

/** The provider rows left after the search box, in list order. */
export function visibleKindRows(
  search: string | null,
): readonly WizardKindOption[] {
  return filterWizardRows(KIND_OPTIONS, search);
}

/** Maps the `pick_kind` cursor index to the row of the filtered list. */
export function kindRowAtCursor(
  cursor: number,
  search: string | null,
): ProvidersWizardKindRow {
  return visibleKindRows(search)[cursor]?.row ?? "openrouter";
}

export function isCuratedCatalogKind(
  kind: NonNullable<ProvidersWizardState["kind"]>,
): boolean {
  return kind === "openrouter" || kind === "aimlapi";
}

export function listChatModelsForKind(
  kind: NonNullable<ProvidersWizardState["kind"]>,
): ReturnType<typeof listOpenRouterChatModels> {
  if (kind === "aimlapi") return listAimlapiChatModels();
  return listOpenRouterChatModels();
}

export function listEmbeddingModelsForKind(
  kind: NonNullable<ProvidersWizardState["kind"]>,
): ReturnType<typeof listOpenRouterEmbeddingModels> {
  if (kind === "aimlapi") return listAimlapiEmbeddingModels();
  return listOpenRouterEmbeddingModels();
}

function nextPhaseAfterApiKey(
  wizard: ProvidersWizardState,
): ProvidersWizardPhase {
  const kind = wizard.kind;
  if (kind && isCuratedCatalogKind(kind)) return "pick_chat_model";
  // A reconfigure run opens on the key screen, so for the manual compat
  // row the URL step still follows it — that is the only screen where a
  // stored endpoint can be corrected. The add flow collected the URL
  // before the key instead. Presets and Gemini know their endpoint (#69).
  if (kind === "openai-compatible" && !wizard.presetId && wizard.mode === "configure") {
    return "base_url";
  }
  return "chat_model_line";
}

/**
 * `true` when the wizard should stop on the API-key screen for this
 * preset. Services that list models without credentials, and local
 * servers with no key at all, skip it: asking for a key that does not
 * exist is the dead end presets exist to remove (#69).
 */
export function presetNeedsKeyScreen(presetId: string): boolean {
  const preset = findProviderPreset(presetId);
  if (!preset) return true;
  return !preset.listsModelsWithoutKey && !preset.local;
}

/**
 * `true` on the screen the wizard opened at, which has no "back" inside
 * the run. Adding starts on the provider list; reconfiguring starts on
 * the key screen, having been opened from a row the operator already
 * chose. Stepping back from there used to build a `pick_kind` screen
 * that run never showed, dropping the entry's kind and base URL with it.
 */
export function isWizardFirstScreen(wizard: ProvidersWizardState): boolean {
  if (wizard.phase === "pick_kind") return true;
  if (wizard.mode !== "configure") return false;
  if (wizard.phase === "api_key") return true;
  // A CLI-backed configure run opens straight on the model line (there
  // is no key screen); Esc there must close the wizard, not rebuild a
  // pick_kind screen the run never showed.
  return (
    wizard.phase === "chat_model_line" &&
    wizard.kind !== null &&
    subscriptionCliForWizardKind(wizard.kind) !== null
  );
}

/**
 * Where the cursor lands when Esc returns to the provider list: on the
 * row the operator came from, so stepping back and forth is stable.
 */
export function cursorForPreviousPick(wizard: ProvidersWizardState): number {
  if (wizard.presetId) {
    const idx = KIND_ROW_ORDER.findIndex(
      (row) => typeof row === "object" && row.presetId === wizard.presetId,
    );
    if (idx >= 0) return idx;
  }
  if (wizard.kind) {
    const idx = KIND_ROW_ORDER.indexOf(wizard.kind);
    if (idx >= 0) return idx;
  }
  return 0;
}

/**
 * Last valid index for `cursor`, `0` for an empty list. The live catalog
 * cache can be replaced under an open wizard (TTL refresh finishing
 * between two keypresses), so every read of `wizard.cursor` against a
 * list must clamp first: the render layer highlights the clamped row,
 * and selection has to pick that same row, never `models[0]`.
 */
export function clampCursor(cursor: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(cursor, 0), length - 1);
}

/**
 * Rows the current list screen shows, after the search box.
 *
 * Every read of `wizard.cursor` on a list phase goes through this one
 * list: the counter, the highlight, and whatever Enter selects all have
 * to name the same row, and that list shrinks as the operator types.
 * Returns `[]` for the phases that are not lists.
 */
export function visibleRowsForPhase(
  wizard: ProvidersWizardState,
): readonly WizardFilterRow[] {
  const { phase, kind, search } = wizard;
  if (phase === "pick_kind") return visibleKindRows(search);
  if (phase === "pick_chat_model" && kind && isCuratedCatalogKind(kind)) {
    return filterWizardRows(
      chatRowsForPricing(kind, wizard.pricingFilter),
      search,
    );
  }
  if (phase === "pick_embedding" && kind && isCuratedCatalogKind(kind)) {
    return filterWizardRows(listEmbeddingModelsForKind(kind), search);
  }
  return [];
}

/**
 * The chat-model rows left after the price facet (`p`). Runs before the
 * search box so both narrow one list, and reads only row ids against the
 * catalog map — never the lazy labels, which keeps a facet flip linear
 * on a 340-row catalog (see `providers-model-options`).
 */
function chatRowsForPricing(
  kind: NonNullable<ProvidersWizardState["kind"]>,
  filter: ModelPricingFilter,
): ReturnType<typeof listChatModelsForKind> {
  const rows = listChatModelsForKind(kind);
  if (filter === "all") return rows;
  const lookup = catalogEntryLookupForKind(kind);
  return rows.filter((row) =>
    matchesModelPricingFilter(filter, row.id, lookup?.(row.id)),
  );
}

/**
 * State every phase change resets. A query typed to find one row must
 * not still be narrowing the next screen's list, where the operator has
 * no reason to expect it and nothing they typed is on show. The price
 * facet resets for the same reason: it belongs to the screen it was
 * cycled on, never to the next one.
 */
const PHASE_ENTRY = {
  cursor: 0,
  search: null,
  pricingFilter: "all",
  error: null,
} as const;

export function advanceWizardPhase(
  wizard: ProvidersWizardState,
): ProvidersWizardState {
  const { phase, kind } = wizard;
  if (phase === "pick_kind" && kind) {
    // A CLI-backed provider has no key to paste — it authenticates from
    // the CLI's own session — so the key screen would be a dead end.
    if (subscriptionCliForWizardKind(kind)) {
      return { ...wizard, ...PHASE_ENTRY, phase: "chat_model_line" };
    }
    // The manual compat row describes its endpoint before authenticating
    // to it: the key screen consults the base URL (a loopback server is
    // keyless — `wizardKeyIsOptional`), so the URL has to exist first.
    // Every other kind already knows its endpoint and goes straight to
    // the key.
    if (kind === "openai-compatible" && !wizard.presetId) {
      return { ...wizard, ...PHASE_ENTRY, phase: "base_url" };
    }
    return { ...wizard, ...PHASE_ENTRY, phase: "api_key" };
  }
  if (phase === "api_key" && kind) {
    return { ...wizard, ...PHASE_ENTRY, phase: nextPhaseAfterApiKey(wizard) };
  }
  if (phase === "pick_chat_model" && kind && isCuratedCatalogKind(kind)) {
    const models = visibleRowsForPhase(wizard);
    // Clamped, not `?? models[0]`: when the list shrank under the cursor
    // — a catalog TTL refresh landing, or the search box narrowing it —
    // the highlighted row is the last one, and Enter must select exactly
    // what is highlighted.
    const picked = models[clampCursor(wizard.cursor, models.length)]?.id ?? null;
    return {
      ...wizard,
      ...PHASE_ENTRY,
      phase: "pick_embedding",
      selectedChatModelId: picked,
    };
  }
  if (phase === "base_url" && kind === "openai-compatible") {
    // Adding walks URL → key; a reconfigure run opened on the key screen
    // and edits the URL after it, so from there it proceeds to the model.
    const next = wizard.mode === "configure" ? "chat_model_line" : "api_key";
    return { ...wizard, ...PHASE_ENTRY, phase: next };
  }
  // `chat_model_line` is the last step for the compat/preset path: the
  // embedding screen is gone from the flow, embeddings stay on the local
  // daemon (which keeps notes on the machine) and remain changeable in
  // the LLM tab. Submitting from here is handled in the key bindings.
  return wizard;
}

export function isListPhase(phase: ProvidersWizardPhase): boolean {
  return (
    phase === "pick_kind" ||
    phase === "pick_chat_model" ||
    phase === "pick_embedding"
  );
}

export function isLinePhase(phase: ProvidersWizardPhase): boolean {
  return phase === "base_url" || phase === "chat_model_line";
}
