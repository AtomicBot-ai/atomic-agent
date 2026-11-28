import { ConfigValidationError } from "../config-validation-error.js";
import {
  parseLocalModelSampling,
  SamplingSetError,
  type LocalModelSampling,
} from "../../local-llm/catalog/model-sampling-sets.js";

/**
 * Config parsing for per-model sampling (ATO-2482): the `sampling` of an
 * added model (`localModels.customModels[].sampling`) and the override
 * map for any model (`localModels.modelSamplingOverrides`). Both are
 * the person's own choice, so they apply whether `localModels.modelSampling`
 * is on or off. Unversioned and additive: an older file has neither.
 */

export function parseSamplingSetting(
  raw: unknown,
  field: string,
): LocalModelSampling | undefined {
  try {
    return parseLocalModelSampling(raw, field);
  } catch (err) {
    if (err instanceof SamplingSetError) {
      throw new ConfigValidationError(err.field, err.message);
    }
    throw err;
  }
}

/**
 * `{ "<model id>": { temperature, topP, ..., thinking?, noThinking? } }`.
 * An id this build does not know is kept: a newer catalog may hold it,
 * and the entry is inert until that model is loaded. Empty sets drop.
 */
export function parseModelSamplingOverrides(
  raw: unknown,
  field: string,
): Record<string, LocalModelSampling> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected an object keyed by model id");
  }
  const out: Record<string, LocalModelSampling> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (id.trim() === "") {
      throw new ConfigValidationError(field, "a model id key is empty");
    }
    const set = parseSamplingSetting(value, `${field}.${id}`);
    if (set !== undefined) out[id] = set;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
