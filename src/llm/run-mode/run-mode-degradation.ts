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
      return degraded.requested === "fusion"
        ? "Fusion needs a cloud orchestrator — no cloud provider is configured. Staying on local. Add one in Manage → LLM → Cloud (or /llm)."
        : "Cloud mode needs a cloud provider — none is configured. Staying on local. Add one in Manage → LLM → Cloud (or /llm).";
    case "no-local-provider":
      return "Fusion needs local workers — no llama-server provider is configured. Running cloud-only.";
  }
}
