import { compressToolResult } from "../../compressor/result-compressor.js";
import { getToolDescriptorByName, isViewableRareTool } from "../../prompt/tool-descriptors.js";
import { roleAdmits } from "../tool-roles.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { ToolSearchCatalog } from "../tool-search/tool-search.js";

export interface ToolViewDeps {
  /**
   * Search mode's catalog (ATO-558), the same one `tool.search` reads:
   * every tool with its full descriptor, and the names search mode
   * deferred to `# extras` one-liners (`deferredToolNames`). A deferred
   * tool is loadable whatever its static tier — `os.git.status` is
   * `frequent` in the static catalog yet only a one-liner in search
   * mode — and a deferred MCP tool, which the static catalog does not
   * hold, is found here. Absent ⇒ nothing is deferred.
   */
  deferred?: () => ToolSearchCatalog;
}

/**
 * Loads the full args schema for a tool into `session.loadedTools` (via
 * `details.toolLoaded` in `applyStateEffects`).
 *
 * Two kinds of tool are loadable: a `tier: "rare"` one (or one the
 * compact prompt collapses, `compact.tier: "rare"`), which the stable
 * prefix only names, and — under a tool role other than `full`
 * (`tool-roles.ts`) — any tool outside the role, which the prefix lists
 * on its "also available via tool.view" line. In search mode a third:
 * any tool search mode deferred (`ToolViewDeps.deferred`). A frequent tool the
 * current role already describes in full is refused as before: there is
 * nothing to load, and a loaded copy would only duplicate the prefix in
 * the tail.
 */
export function buildToolViewTool(deps: ToolViewDeps = {}): ToolDefinition {
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
      const catalog = deps.deferred?.();
      const deferred = catalog?.deferred.has(name) === true;
      const d =
        (deferred ? catalog?.descriptors.find((x) => x.name === name) : undefined) ??
        getToolDescriptorByName(name);
      if (!d) {
        throw new Error(
          catalog !== undefined && catalog.deferred.size > 0
            ? `tool.view: unknown tool: ${name} (to find a tool by what it does, call tool.search)`
            : `tool.view: unknown tool: ${name}`,
        );
      }
      const role = ctx.toolRole ?? "full";
      const outsideRole = !roleAdmits(role, d.name);
      // Rare in either scaffold: the compact prompt (ATO-1116) lists
      // more tools as one-liners than the full one does; search mode
      // (ATO-558) defers more still.
      if (!isViewableRareTool(d) && !outsideRole && !deferred) {
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
