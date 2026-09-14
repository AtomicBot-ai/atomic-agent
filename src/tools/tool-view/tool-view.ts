import { compressToolResult } from "../../compressor/result-compressor.js";
import { getToolDescriptorByName } from "../../prompt/tool-descriptors.js";
import { roleAdmits } from "../tool-roles.js";
import type { ToolDefinition } from "../tool-registry.js";

/**
 * Loads the full args schema for a tool into `session.loadedTools` (via
 * `details.toolLoaded` in `applyStateEffects`).
 *
 * Two kinds of tool are loadable: a `tier: "rare"` one, which the
 * stable prefix only names, and — under a tool role other than `full`
 * (`tool-roles.ts`) — any tool outside the role, which the prefix lists
 * on its "also available via tool.view" line. A frequent tool the
 * current role already describes in full is refused as before: there is
 * nothing to load, and a loaded copy would only duplicate the prefix in
 * the tail.
 */
export function buildToolViewTool(): ToolDefinition {
  return {
    name: "tool.view",
    description:
      "Load the full args schema for a rare (extras) or out-of-role tool into the prompt tail.",
    readonly: true,
    async run(rawArgs, ctx) {
      const name = rawArgs.name;
      if (typeof name !== "string" || name.length === 0) {
        throw new Error("tool.view: `name` must be a non-empty string");
      }
      const d = getToolDescriptorByName(name);
      if (!d) {
        throw new Error(`tool.view: unknown tool: ${name}`);
      }
      const role = ctx.toolRole ?? "full";
      const outsideRole = !roleAdmits(role, d.name);
      if (d.tier !== "rare" && !outsideRole) {
        throw new Error(
          `tool.view: "${name}" is not in the # extras list (full schema is already in the stable prefix)`,
        );
      }
      return compressToolResult(
        {
          tool: "tool.view",
          status: "ok",
          output: outsideRole
            ? `Loaded schema for \`${d.name}\` into \`### loaded-tools\` (outside this turn's \`${role}\` tool set; callable from the next step).`
            : `Loaded schema for \`${d.name}\` into \`### loaded-tools\`.`,
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
