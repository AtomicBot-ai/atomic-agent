import {
  acceptSamplingValue,
  SAMPLING_FIELDS,
  type ModelSamplingDefaults,
} from "./gguf-sampling.js";

/**
 * Sampling for one model, with an optional set per thinking mode
 * (ATO-2482). The top-level fields apply in both modes; `thinking` and
 * `noThinking` replace them field by field for a request that thinks or
 * one that does not. Qwen's model cards give two sets (thinking 1.0 /
 * 0.95 / 20, thinking off 0.7 / 0.8 / 20 with presence penalty 1.5);
 * Gemma 4, Nemotron and Muse give one set for both.
 *
 * Used by catalog entries (`LocalModelDef.sampling`), by an added
 * model's own entry (`localModels.customModels[].sampling`) and by the
 * per-model override (`localModels.modelSamplingOverrides`).
 */
export interface LocalModelSampling extends ModelSamplingDefaults {
  thinking?: ModelSamplingDefaults;
  noThinking?: ModelSamplingDefaults;
}

export type SamplingMode = "thinking" | "noThinking";

/** The flat set one request gets: the mode's fields over the shared ones. */
export function samplingForMode(
  set: LocalModelSampling | undefined,
  mode: SamplingMode,
): ModelSamplingDefaults {
  if (!set) return {};
  const out: ModelSamplingDefaults = {};
  const variant = set[mode];
  for (const field of SAMPLING_FIELDS) {
    const value = variant?.[field] ?? set[field];
    if (value !== undefined) out[field] = value;
  }
  return out;
}

/** `primary`'s fields over `fallback`'s, keeping every defined field. */
export function layerSampling(
  primary: ModelSamplingDefaults,
  fallback: ModelSamplingDefaults,
): ModelSamplingDefaults {
  const out: ModelSamplingDefaults = {};
  for (const field of SAMPLING_FIELDS) {
    const value = primary[field] ?? fallback[field];
    if (value !== undefined) out[field] = value;
  }
  return out;
}

export function hasSamplingFields(set: ModelSamplingDefaults | undefined): boolean {
  return set !== undefined && SAMPLING_FIELDS.some((f) => set[f] !== undefined);
}

/** Whether a set names anything at all, in either mode. */
export function isEmptyLocalModelSampling(set: LocalModelSampling | undefined): boolean {
  return (
    !hasSamplingFields(set) &&
    !hasSamplingFields(set?.thinking) &&
    !hasSamplingFields(set?.noThinking)
  );
}

export class SamplingSetError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "SamplingSetError";
  }
}

function parseFlat(
  raw: Record<string, unknown>,
  where: string,
): ModelSamplingDefaults {
  const out: ModelSamplingDefaults = {};
  for (const field of SAMPLING_FIELDS) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    const accepted = acceptSamplingValue(field, value);
    if (accepted === undefined) {
      throw new SamplingSetError(
        `${where}.${field}`,
        `${JSON.stringify(value)} is outside the range llama.cpp takes`,
      );
    }
    out[field] = accepted;
  }
  return out;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

/**
 * Validate a stored set. Unknown keys are ignored (a newer build may
 * add a field); a known field out of range is an error, so a typo such
 * as `temperature: 70` is refused rather than dropped without a word.
 * `undefined` / `null` / an empty set all read as "no set".
 */
export function parseLocalModelSampling(
  raw: unknown,
  where: string,
): LocalModelSampling | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new SamplingSetError(where, "expected an object");
  const out: LocalModelSampling = parseFlat(raw, where);
  for (const mode of ["thinking", "noThinking"] as const) {
    const sub = raw[mode];
    if (sub === undefined || sub === null) continue;
    if (!isRecord(sub)) {
      throw new SamplingSetError(`${where}.${mode}`, "expected an object");
    }
    const parsed = parseFlat(sub, `${where}.${mode}`);
    if (hasSamplingFields(parsed)) out[mode] = parsed;
  }
  return isEmptyLocalModelSampling(out) ? undefined : out;
}
