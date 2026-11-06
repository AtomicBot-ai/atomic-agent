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
 * Smallest planned summary for which `auto` asks the model on a local
 * llama-server without prefix reuse. Most current small local models are
 * hybrid or use sliding-window layers (Qwen3.5, Gemma 4), so that rule
 * decided the method for nearly all of them and their compaction was always
 * extractive, on any window (ATO-895). Where the history allowance gives a
 * summary this large (about a 32k window and up) compaction is rare and
 * its source small enough that one summary call costs about one step,
 * which such a model already re-reads in full. Below it (a 16k window)
 * compaction fires every step or two, and a model call each time would
 * about double the step time, so the summary stays extractive.
 */
export const NO_REUSE_MODEL_SUMMARY_MIN_TOKENS = 1024;

/**
 * Which method makes this checkpoint. `model` and `extractive` are taken
 * as configured. `auto` picks extractive for a local llama-server whose
 * source is at least {@link AUTO_EXTRACTIVE_LOCAL_SOURCE_TOKENS}, or whose
 * prefix reuse is `none` and whose planned summary (`summaryMaxTokens`)
 * is under {@link NO_REUSE_MODEL_SUMMARY_MIN_TOKENS} (unknown counts as
 * under); a cloud or other route keeps the model summary. `sourceTokens`
 * is evaluated only for a local route that is not already decided, so
 * other routes never pay for serializing the source.
 */
export function chooseCompactionMethod(mode: CompactionMode, route: CompactionRouteFacts, sourceTokens: () => number, summaryMaxTokens?: number): "model" | "extractive" {
  if (mode !== "auto") return mode;
  if (!route.local) return "model";
  if (route.prefixReuse === "none" && (summaryMaxTokens ?? 0) < NO_REUSE_MODEL_SUMMARY_MIN_TOKENS) return "extractive";
  return sourceTokens() >= AUTO_EXTRACTIVE_LOCAL_SOURCE_TOKENS ? "extractive" : "model";
}
