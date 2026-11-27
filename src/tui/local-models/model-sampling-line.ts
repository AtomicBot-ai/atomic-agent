import type { LocalModelDef } from "../../local-llm/index.js";
import {
  isEmptyLocalModelSampling,
  type LocalModelSampling,
} from "../../local-llm/catalog/model-sampling-sets.js";

/**
 * The one line a model's detail view shows about its sampling
 * (ATO-2482): whether the person set their own values or the model runs
 * on its default, and how to change it. Editing happens in
 * `atomic-agent models sampling` (and the desktop's Sampling row); the
 * terminal view only says where it stands, as Claude Code's `/model`
 * points at the setting rather than editing every knob in place.
 */
export function modelSamplingLine(
  def: LocalModelDef,
  localModels: {
    modelSampling?: boolean;
    modelSamplingOverrides?: Readonly<Record<string, LocalModelSampling>>;
  },
): string {
  const own =
    localModels.modelSamplingOverrides?.[def.id] ??
    (def.family === "custom" ? def.sampling : undefined);
  if (own && !isEmptyLocalModelSampling(own)) {
    return `sampling: custom · atomic-agent models sampling ${def.id} --reset for the default`;
  }
  const hasDefault = def.family !== "custom" && !isEmptyLocalModelSampling(def.sampling);
  const state =
    localModels.modelSampling === true
      ? "model default"
      : hasDefault
        ? "built-in (the model's own values are off: localModels.modelSampling)"
        : "built-in";
  return `sampling: ${state} · atomic-agent models sampling ${def.id}`;
}
