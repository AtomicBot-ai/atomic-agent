import {
  modelBrand,
  providerBrand,
  providerRowBrand,
  type Brand,
} from "../brand/brand-badges.js";
import type { ComposerSwitchRow } from "./composer-switch-row-contracts.js";

/**
 * The brand a composer-switch row wears (ATO-1635), read off what the
 * row already carries — its intent — so the row builders stay as they
 * are.
 *
 * Three answers, not two: a `Brand`; `null` for a row that names a
 * provider or a model with no brand of its own (a custom endpoint, the
 * local seat), drawn as a blank of the badge's width; and `undefined`
 * for a row that is not a provider or a model at all (a route, the
 * worker count, "Add a new provider"). The popup reserves the badge
 * column only when some row on screen has a brand to show.
 */
export function switchRowBrand(
  row: ComposerSwitchRow,
): Brand | null | undefined {
  const intent = row.intent;
  switch (intent.kind) {
    case "llmRow": {
      const llm = intent.row;
      if (llm.kind === "cloudProvider") return providerRowBrand(llm.provider);
      if (llm.kind === "cloudChatModel") return modelBrand(llm.modelId);
      if (llm.kind === "localTextModel") return modelBrand(llm.model.id);
      return null;
    }
    case "fusionLeg":
      return intent.providerId === "local-llama"
        ? null
        : providerBrand(intent.providerId);
    case "fusionModel":
      return modelBrand(intent.modelId);
    case "fusionWorkerModel":
      return modelBrand(intent.modelId);
    case "localEngine":
      return null;
    default:
      return undefined;
  }
}

/** Whether a list of rows needs the badge column at all. */
export function switchRowsShowBrands(
  rows: readonly ComposerSwitchRow[],
): boolean {
  return rows.some((row) => switchRowBrand(row) !== undefined);
}
