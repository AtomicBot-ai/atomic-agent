/**
 * How a local model is named and how much memory it is said to need, in
 * one place for the terminal and the desktop (ATO-1410).
 *
 * TWO COPIES, ONE TEXT. This file lives at
 * `src/local-llm/catalog/model-memory-words.ts` (the agent) and at
 * `desktop/main/model-memory-words.ts` (the desktop, which runs against a
 * released agent binary and cannot import agent source). The two files
 * must stay byte-identical: `desktop/test/model-catalog-drift.test.mjs`
 * fails the moment they differ, and also runs both against the catalogue.
 * Edit one, copy it over the other.
 *
 * No imports on purpose, so the desktop test can load this file straight
 * from the agent tree, and so it compiles under both builds.
 *
 * The one memory figure. A curated model's `recommendedRamGb` is the
 * number both clients call "needs": at or above it the model runs at
 * full speed. `minRamGb` is only the floor of the "tight fit" band; below
 * it the model does not start. Neither is estimated for a curated model:
 * both come from the catalogue as written. A model added by the operator
 * (Hugging Face, a local GGUF) has no catalogue entry, so both figures
 * come from its file size through {@link estimateRamGbFromFileSize}, the
 * one size rule both clients use.
 */

/** The two figures a fit is judged on, in whole GB. */
export interface ModelRamFigures {
  minRamGb: number;
  recommendedRamGb: number;
}

/** "comfortable": at or over the need; "tight": between floor and need; "over": under the floor. */
export type ModelMemoryFit = "comfortable" | "tight" | "over";

/**
 * The size rule for a model no catalogue describes: the floor at 1.2× the
 * weights, the need at 1.5× plus 2 GB for the system and the cache. It was
 * already what the agent stored for every model added from Hugging Face or
 * from a local file; the desktop's own 1.6× guess is gone in its favour.
 */
export function estimateRamGbFromFileSize(fileSizeGb: number): ModelRamFigures {
  const gb = Number.isFinite(fileSizeGb) && fileSizeGb > 0 ? fileSizeGb : 0;
  return {
    minRamGb: Math.max(1, Math.ceil(gb * 1.2)),
    recommendedRamGb: Math.max(2, Math.ceil(gb * 1.5) + 2),
  };
}

/** The one "needs N GB" figure: the catalogue's `recommendedRamGb`. */
export function modelMemoryNeedGb(model: ModelRamFigures): number {
  return model.recommendedRamGb;
}

/** How the model fits a machine with `ramGb` of memory. */
export function modelMemoryFit(model: ModelRamFigures, ramGb: number): ModelMemoryFit {
  if (ramGb >= model.recommendedRamGb) return "comfortable";
  if (ramGb >= model.minRamGb) return "tight";
  return "over";
}

/** "needs 20 GB", the words both clients print next to a model. */
export function modelMemoryNeedWords(model: ModelRamFigures): string {
  return `needs ${modelMemoryNeedGb(model)} GB`;
}

/**
 * The name a person reads: the catalogue's `name` without the file-format
 * tail ("Gemma 4 E4B QAT GGUF" becomes "Gemma 4 E4B"), else the id. The
 * desktop has trimmed names this way since Calm S2; the terminal printed
 * the id.
 */
export function modelDisplayName(model: { id: string; name?: string | null }): string {
  const name = typeof model.name === "string" ? model.name.trim() : "";
  if (!name) return model.id;
  return name.replace(/\s+(?:QAT\s+)?GGUF$/i, "") || model.id;
}
