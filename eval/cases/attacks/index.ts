import type { EvalCase } from "../../harness/case-schema.js";

/**
 * Attack cases for `npm run eval:attacks` (ATO-623). Each one is an
 * `EvalCase` with `category: "attack"` and an `attack` spec; see
 * "Attack suite" in eval/README.md for the format. Not part of
 * `EVAL_CASES`, so `npm run eval` never runs them.
 *
 * Empty for now: the scenario texts are written by a maintainer.
 */
export const ATTACK_CASES: readonly EvalCase[] = [];
