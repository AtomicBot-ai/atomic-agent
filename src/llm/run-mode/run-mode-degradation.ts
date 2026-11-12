import type { RunModeDegradation } from "./resolve-run-mode.js";

/**
 * Operator-visible sentence for a run-mode degradation.
 *
 * Kept out of `resolveRunMode` so the resolver stays a pure projection
 * and the wording can be asserted on its own — and so the TUI, the CLI
 * and any HTTP surface all say exactly the same thing.
 */
export function describeRunModeDegradation(
  degraded: RunModeDegradation,
): string {
  switch (degraded.reason) {
    case "no-cloud-provider":
      // Plain words, no menu path: every surface that shows this line
      // also offers the way to add one (the TUI's `[add cloud provider]`
      // chip, the desktop's own button), so the sentence only has to say
      // what is missing and what happens meanwhile (ATO-1460).
      return degraded.requested === "fusion"
        ? "Fusion needs a cloud model to plan the work. You don't have one yet, so answers come from the local model."
        : "Cloud mode needs a cloud model. You don't have one yet, so answers come from the local model.";
    case "no-second-provider":
      // Either leg may be cloud or local; what fusion cannot do is run
      // both of them on the same provider.
      return "Fusion needs two providers — one to orchestrate and one to run the workers. Only one is configured. Add another in Manage → LLM (or /llm).";
  }
}
