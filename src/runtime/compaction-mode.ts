import type { CompactionMode } from "../config/agent/compaction-config.js";

/**
 * Under `auto`, a local llama-server summary of at least this many source
 * tokens is built extractively. Prompt evaluation speed on a local model
 * is not known ahead of time, and a 27B model on a laptop reads a few
 * hundred tokens a second, so a source this size already takes minutes.
 */
export const AUTO_EXTRACTIVE_LOCAL_SOURCE_TOKENS = 32_000;

export interface CompactionRouteFacts {
  /** The serving link is a llama-server (managed or external). */
  local?: boolean;
  /** That server's prefix reuse; `none` re-reads the whole prompt after any change. */
  prefixReuse?: "partial" | "none";
}

/**
 * Which method makes this checkpoint. `model` and `extractive` are taken
 * as configured. `auto` picks extractive for a local llama-server whose
 * prefix reuse is `none` (every step after a compaction is a full re-read
 * anyway, and a long summary call blocks the only slot), or whose source is
 * at least {@link AUTO_EXTRACTIVE_LOCAL_SOURCE_TOKENS}; a cloud or other
 * route keeps the model summary. `sourceTokens` is evaluated only for that
 * last case, so other routes never pay for serializing the source.
 */
export function chooseCompactionMethod(mode: CompactionMode, route: CompactionRouteFacts, sourceTokens: () => number): "model" | "extractive" {
  if (mode !== "auto") return mode;
  if (!route.local) return "model";
  if (route.prefixReuse === "none") return "extractive";
  return sourceTokens() >= AUTO_EXTRACTIVE_LOCAL_SOURCE_TOKENS ? "extractive" : "model";
}
