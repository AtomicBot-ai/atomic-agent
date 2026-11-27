import type { LocalModelSampling } from "./model-sampling-sets.js";

/**
 * The sampling the model cards recommend for the curated catalog
 * (ATO-2482), read off each upstream card on 28.11.2026. A catalog entry
 * names one of these as `sampling`; the GGUF header's `general.sampling.*`
 * keys fill whatever a set leaves out.
 *
 * Why a table in code and not only the header: three Qwen 3.5 files
 * (2B, 4B, 9B) and Muse Glimmer ship no `general.sampling.*` keys, and no
 * header anywhere carries a thinking-off set (the keys mirror the
 * upstream `generation_config.json`, which holds the thinking values).
 *
 * Left out on purpose: the cards' `presence_penalty` (1.5 for most Qwen
 * sets). It is a chat setting; on a grammar-held JSON tool call it taxes
 * every repeated quote and brace. The fit-test decides it (ATO-2480);
 * a person can still set it per model.
 */

/**
 * Qwen3.5 4B / 9B / 35B-A3B, Qwen3.6 and Qwen3.8 (the reduced-refusal
 * 3.8 build too): the "Best practices" tables of Qwen/Qwen3.5-4B,
 * Qwen/Qwen3.6-27B and Qwen/Qwen3.8-27B agree on these fields.
 */
export const QWEN_SAMPLING: LocalModelSampling = {
  topK: 20,
  minP: 0,
  repeatPenalty: 1,
  thinking: { temperature: 1, topP: 0.95 },
  noThinking: { temperature: 0.7, topP: 0.8 },
};

/** Qwen3.5 2B: thinks only when asked; its thinking-off set is wider. */
export const QWEN_35_SMALL_SAMPLING: LocalModelSampling = {
  topK: 20,
  minP: 0,
  repeatPenalty: 1,
  thinking: { temperature: 1, topP: 0.95 },
  noThinking: { temperature: 1, topP: 1 },
};

/** Gemma 4: one set for thinking on and off (google/gemma-4-31B-it). */
export const GEMMA_4_SAMPLING: LocalModelSampling = {
  temperature: 1,
  topP: 0.95,
  topK: 64,
};

/** Nemotron 3.5 Lightning: temperature and top-p only, both modes. */
export const NEMOTRON_35_SAMPLING: LocalModelSampling = {
  temperature: 1,
  topP: 0.95,
};

/** Muse Glimmer: one set; reasoning strength is a prompt line, not sampling. */
export const MUSE_GLIMMER_SAMPLING: LocalModelSampling = {
  temperature: 1,
  topP: 0.95,
  topK: 64,
};
