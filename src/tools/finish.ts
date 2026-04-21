import { compressToolResult } from "../compressor/result-compressor.js";
import type { ToolDefinition } from "./tool-registry.js";

/**
 * Terminal tool — emitting this call ends the agent loop. The `summary`
 * argument is the final user-visible statement of what was accomplished.
 */
export const finishTool: ToolDefinition = {
  name: "finish",
  description: "Signal goal completion and return a short summary.",
  readonly: true,
  async run(rawArgs) {
    const summary = rawArgs.summary;
    if (typeof summary !== "string" || summary.length === 0) {
      throw new Error("finish: `summary` must be a non-empty string");
    }
    return compressToolResult({
      tool: "finish",
      status: "ok",
      output: summary,
      details: { summary, final: true },
    });
  },
};
