import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readGgufMetadata, type GgufValue } from "./gguf-metadata.js";

/**
 * The sampling a local model's authors recommend (ATO-2202), read from
 * the model itself rather than one table for every model:
 *
 * - the GGUF header's `general.sampling.*` keys, which llama.cpp's
 *   converter writes from the source repo's `generation_config.json`
 *   and which llama.cpp reads as its own defaults;
 * - a `generation_config.json` lying next to the GGUF file (a folder
 *   copied from a Hugging Face repo), for a header without those keys.
 *
 * The header wins field by field; the JSON only fills what it left out.
 * Every field is optional: a model that says nothing keeps the client's
 * built-in sampling. Precedent: Ollama's Modelfile `PARAMETER` layer,
 * LM Studio's per-model defaults and llama.cpp's own `general.sampling.*`
 * read, each applied under anything the request sets itself.
 */
export interface ModelSamplingDefaults {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  repeatLastN?: number;
}

type SamplingField = keyof ModelSamplingDefaults;

/** llama.cpp's key for each field (`LLM_KV_GENERAL_SAMPLING_*`). */
export const GGUF_SAMPLING_KEYS: Readonly<Record<SamplingField, string>> = {
  temperature: "general.sampling.temp",
  topP: "general.sampling.top_p",
  topK: "general.sampling.top_k",
  minP: "general.sampling.min_p",
  repeatPenalty: "general.sampling.penalty_repeat",
  repeatLastN: "general.sampling.penalty_last_n",
};

/** Transformers' name for each field in `generation_config.json`. */
const GENERATION_CONFIG_KEYS: Readonly<Partial<Record<SamplingField, string>>> = {
  temperature: "temperature",
  topP: "top_p",
  topK: "top_k",
  minP: "min_p",
  repeatPenalty: "repetition_penalty",
};

/**
 * Accept a value only inside the range llama.cpp takes for it; anything
 * else (a NaN, a negative top-p, a temperature of 50) is dropped so a
 * broken header cannot steer the decode somewhere absurd.
 */
function accept(field: SamplingField, raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  // A header stores these as FLOAT32: 0.95 reads back as 0.94999998.
  // Seven significant digits give the number the converter was given.
  const value = Number(raw.toPrecision(7));
  switch (field) {
    case "temperature":
      return value >= 0 && value <= 5 ? value : undefined;
    case "topP":
      return value > 0 && value <= 1 ? value : undefined;
    case "minP":
      return value >= 0 && value <= 1 ? value : undefined;
    case "topK":
      return Number.isInteger(value) && value >= 0 ? value : undefined;
    case "repeatPenalty":
      return value > 0 && value <= 5 ? value : undefined;
    case "repeatLastN":
      // `-1` (the whole context) is left out: over a long agent prompt it
      // would penalise copying a path or an edit's old text from context.
      return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
}

/** The `general.sampling.*` values of a parsed GGUF header. */
export function samplingFromGgufKeys(
  keys: Readonly<Record<string, GgufValue>>,
): ModelSamplingDefaults {
  const out: ModelSamplingDefaults = {};
  for (const field of Object.keys(GGUF_SAMPLING_KEYS) as SamplingField[]) {
    const value = accept(field, keys[GGUF_SAMPLING_KEYS[field]]);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

/**
 * The sampling fields of a parsed `generation_config.json`. A config
 * that says `do_sample: false` asks for greedy decoding, so its
 * temperature and friends are not recommendations: nothing is taken.
 */
export function samplingFromGenerationConfig(
  json: unknown,
): ModelSamplingDefaults {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return {};
  }
  const record = json as Record<string, unknown>;
  if (record.do_sample === false) return {};
  const out: ModelSamplingDefaults = {};
  for (const field of Object.keys(GENERATION_CONFIG_KEYS) as SamplingField[]) {
    const key = GENERATION_CONFIG_KEYS[field];
    const value = key === undefined ? undefined : accept(field, record[key]);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

/** `primary`'s fields over `fallback`'s; `null` when neither has any. */
export function mergeSampling(
  primary: ModelSamplingDefaults,
  fallback: ModelSamplingDefaults,
): ModelSamplingDefaults | null {
  const merged = { ...fallback, ...primary };
  return Object.keys(merged).length > 0 ? merged : null;
}

/** Same fields, same values: whether a refresh changed what a model asks for. */
export function sameSampling(
  a: ModelSamplingDefaults | undefined,
  b: ModelSamplingDefaults | undefined,
): boolean {
  const fields = Object.keys(GGUF_SAMPLING_KEYS) as SamplingField[];
  return fields.every((field) => a?.[field] === b?.[field]);
}

export interface ReadModelSamplingDeps {
  readHeaderKeys?: (path: string) => Promise<Record<string, GgufValue>>;
  readText?: (path: string) => Promise<string>;
}

/**
 * The recommended sampling for the model file at `modelPath`, or `null`
 * when neither its header nor a sibling `generation_config.json` names
 * any. Best-effort: an unreadable header or a missing / malformed JSON
 * file is simply a source that said nothing.
 */
export async function loadModelSamplingDefaults(
  modelPath: string,
  deps: ReadModelSamplingDeps = {},
): Promise<ModelSamplingDefaults | null> {
  const readHeaderKeys =
    deps.readHeaderKeys ?? (async (path) => (await readGgufMetadata(path)).keys);
  const readText = deps.readText ?? ((path) => readFile(path, "utf8"));
  let fromHeader: ModelSamplingDefaults = {};
  try {
    fromHeader = samplingFromGgufKeys(await readHeaderKeys(modelPath));
  } catch {
    // Not GGUF, or unreadable: the JSON may still say something.
  }
  let fromJson: ModelSamplingDefaults = {};
  try {
    const text = await readText(join(dirname(modelPath), "generation_config.json"));
    fromJson = samplingFromGenerationConfig(JSON.parse(text));
  } catch {
    // No sibling file, or not JSON.
  }
  return mergeSampling(fromHeader, fromJson);
}

const samplingCache = new Map<string, Promise<ModelSamplingDefaults | null>>();

/**
 * `loadModelSamplingDefaults` memoised per path for the life of the
 * process, as `readModelPrefixReuse` is: a model file does not change
 * under a running server, and the profile refresh asks at every turn.
 */
export function readModelSamplingDefaults(
  modelPath: string,
): Promise<ModelSamplingDefaults | null> {
  let pending = samplingCache.get(modelPath);
  if (!pending) {
    pending = loadModelSamplingDefaults(modelPath).catch(() => null);
    samplingCache.set(modelPath, pending);
  }
  return pending;
}

/** Test seam: forget memoised readings. */
export function resetModelSamplingCache(): void {
  samplingCache.clear();
}
