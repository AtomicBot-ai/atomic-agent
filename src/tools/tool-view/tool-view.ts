import { compressToolResult } from "../../compressor/result-compressor.js";
import { getToolDescriptorByName } from "../../prompt/tool-descriptors.js";
import type { ToolDefinition } from "../tool-registry.js";

/**
 * Loads the full args schema for a `tier: "rare"` tool into
 * `session.loadedTools` (via `details.toolLoaded` in `applyStateEffects`).
 */
export function buildToolViewTool(): ToolDefinition {
  return {
    name: "tool.view",
    description:
      "Load the full args schema for a rare (extras) tool into the prompt tail.",
    readonly: true,
    async run(rawArgs) {
      const name = rawArgs.name;
      if (typeof name !== "string" || name.length === 0) {
        throw new Error("tool.view: `name` must be a non-empty string");
      }
      const d = getToolDescriptorByName(name);
      if (!d) {
        throw new Error(`tool.view: unknown tool: ${name}`);
      }
      if (d.tier !== "rare") {
        throw new Error(
          `tool.view: "${name}" is not in the # extras list (full schema is already in the stable prefix)`,
        );
      }
      return compressToolResult(
        {
          tool: "tool.view",
          status: "ok",
          output: `Loaded schema for \`${d.name}\` into \`### loaded-tools\`.`,
          details: {
            toolLoaded: {
              name: d.name,
              summary: d.summary,
              argsSchema: d.argsSchema,
              ...(d.examples && d.examples.length > 0
                ? { examples: [...d.examples] }
                : {}),
              source: "explicit" as const,
            },
          },
        },
        { maxSummaryLength: 500, maxTailLines: 20 },
      );
    },
  };
}
