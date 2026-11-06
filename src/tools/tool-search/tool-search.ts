import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDescriptor } from "../../prompt/stable-prefix.js";
import type { ToolDefinition } from "../tool-registry.js";
import { CORE_TOOL_NAMES, TOOL_SEARCH_NAME } from "./tool-search-policy.js";
import { callShape, searchTools } from "./tool-search-rank.js";

/** Results per search: enough to choose from, few enough to stay small. */
export const TOOL_SEARCH_DEFAULT_LIMIT = 3;
export const TOOL_SEARCH_MAX_LIMIT = 8;
/** Schemas loaded into `### loaded-tools` per search (the top hits). */
export const TOOL_SEARCH_LOADED = 3;
/** Cap on one result's printed args sketch. */
const MAX_ARGS_CHARS = 600;

export interface ToolSearchCatalog {
  /** Every tool the session may call, with its FULL description. */
  descriptors: readonly ToolDescriptor[];
  /** Names the prompt lists as one-liners only (to load on a hit). */
  deferred: ReadonlySet<string>;
}

export interface ToolSearchDeps {
  catalog: () => ToolSearchCatalog;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * `tool.search { query, limit? }` (ATO-558): find a tool listed under
 * `# extras` by what it does. Answers with each hit's summary, args and
 * a ready-to-copy call, and loads the top hits' schemas into
 * `### loaded-tools` (`details.toolsLoaded`) so the next step can call
 * them directly — no `tool.view` round-trip. Reuses `tool.view`'s
 * loaded-tool shape (`tool-view.ts`).
 */
export function buildToolSearchTool(deps: ToolSearchDeps): ToolDefinition {
  return {
    name: TOOL_SEARCH_NAME,
    description:
      "Search all available tools (built-in and MCP) by what they do; returns the best matches with their arguments and a ready call, and loads their schemas so they can be called on the next step.",
    readonly: true,
    async run(rawArgs) {
      const query = rawArgs.query;
      if (typeof query !== "string" || query.trim().length === 0) {
        throw new Error("tool.search: `query` must be a non-empty string (what the tool should do, e.g. \"send slack message\")");
      }
      const rawLimit = rawArgs.limit;
      if (rawLimit !== undefined && rawLimit !== null && (typeof rawLimit !== "number" || !Number.isFinite(rawLimit))) {
        throw new Error("tool.search: `limit` must be a number");
      }
      const limit = Math.min(
        TOOL_SEARCH_MAX_LIMIT,
        Math.max(1, Math.floor(typeof rawLimit === "number" ? rawLimit : TOOL_SEARCH_DEFAULT_LIMIT)),
      );
      const { descriptors, deferred } = deps.catalog();
      // The terminals and the discovery tools are never what one searches for.
      const searchable = descriptors.filter(
        (d) => d.name !== "reply" && d.name !== "finish" && d.name !== TOOL_SEARCH_NAME && d.name !== "tool.view",
      );
      const hits = searchTools(query, searchable, limit);
      if (hits.length === 0) {
        return compressToolResult(
          {
            tool: TOOL_SEARCH_NAME,
            status: "ok",
            output: `No tool matches "${query.trim()}". Try other words (what the tool acts on: "calendar event", "github issue", "send email"), or do it with the tools already described.`,
            details: { query, results: [] },
          },
          { maxSummaryLength: 400 },
        );
      }
      const lines: string[] = [];
      hits.forEach((hit, i) => {
        const d = hit.descriptor;
        const loadedNote = deferred.has(d.name) || d.tier === "rare" ? "" : " (already described in ### tools)";
        lines.push(`${i + 1}. ${d.name}${loadedNote} — ${d.summary}`);
        lines.push(`   args: ${clip(d.argsSchema, MAX_ARGS_CHARS)}`);
        lines.push(`   call: ${callShape(d)}`);
      });
      const toLoad = hits
        .map((h) => h.descriptor)
        .filter((d) => (deferred.has(d.name) || d.tier === "rare") && !CORE_TOOL_NAMES.has(d.name))
        .slice(0, TOOL_SEARCH_LOADED);
      if (toLoad.length > 0) {
        lines.push(`Loaded ${toLoad.map((d) => `\`${d.name}\``).join(", ")} into \`### loaded-tools\`. Call the one that fits now, with real values in place of <placeholders>.`);
      } else {
        lines.push("Call the one that fits now, with real values in place of <placeholders>.");
      }
      return compressToolResult(
        {
          tool: TOOL_SEARCH_NAME,
          status: "ok",
          output: lines.join("\n"),
          details: {
            query,
            results: hits.map((h) => h.descriptor.name),
            toolsLoaded: toLoad.map((d) => ({
              name: d.name,
              summary: d.summary,
              argsSchema: d.argsSchema,
              ...(d.examples && d.examples.length > 0 ? { examples: [...d.examples] } : {}),
              source: "explicit" as const,
            })),
          },
        },
        { maxSummaryLength: 4_000, maxTailLines: 60 },
      );
    },
  };
}
