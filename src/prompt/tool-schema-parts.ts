import type {
  ToolCallAdapter,
  ToolDefinitionOptions,
} from "../llm/provider/adapters/tool-call-adapter.js";
import { splitMcpToolName } from "../mcp/mcp-resource-class.js";
import type { BuildPromptInput } from "./build-prompt-types.js";
import {
  BUILTIN_TOOLS_PART,
  apportionParts,
  type MeasuredPart,
  type PromptPart,
} from "./prompt-part-shares.js";
import type { ToolDescriptor } from "./stable-prefix.js";
import { estimateTokens } from "./token-budget.js";

/**
 * The native `tools` array, priced and split by MCP server (ATO-2453).
 *
 * On a `native_tools` link the schemas travel beside the prompt text and
 * were one "tool schemas" row in `/context`. On a small window that row
 * is often the biggest one, and the operator's fix (turn a server off)
 * needs to know whose schemas they are. The split is read off the exact
 * array the request sends, so it covers the same tools the total does.
 */
export interface ToolSchemaMeasure {
  /** `estimateTokens` over the whole serialized array, as before. */
  tokens: number;
  /**
   * Built-in tools plus one part per MCP server, summing to `tokens`.
   * Empty when no MCP server's tools are on the wire: a breakdown with
   * one row restates its parent.
   */
  parts: readonly PromptPart[];
}

/** What a request with no adapter sends: an empty array. */
export const NO_TOOL_SCHEMA: ToolSchemaMeasure = {
  tokens: estimateTokens("[]"),
  parts: [],
};

type SchemaAdapter = Pick<
  ToolCallAdapter,
  "descriptorsToTools" | "wireToCanonical" | "nameUnescape"
>;

/** Build the array the request sends and measure it. */
export function measureToolSchema(
  adapter: SchemaAdapter,
  descriptors: readonly ToolDescriptor[],
  options: ToolDefinitionOptions,
): ToolSchemaMeasure {
  const tools = adapter.descriptorsToTools(descriptors, options);
  const tokens = estimateTokens(JSON.stringify(tools));
  const canonical = adapter.wireToCanonical?.(descriptors, options);
  const nameOf = (wire: string): string =>
    canonical?.get(wire) ?? adapter.nameUnescape(wire);
  return { tokens, parts: toolSchemaParts(tools, tokens, nameOf) };
}

/**
 * `tools` grouped by owner and priced to `total`. `nameOf` turns a wire
 * name back into the qualified `mcp.<server>.<tool>` name; a tool whose
 * name it cannot read counts as built-in.
 */
export function toolSchemaParts(
  tools: ReadonlyArray<Record<string, unknown>>,
  total: number,
  nameOf: (wire: string) => string,
): PromptPart[] {
  const builtin: string[] = [];
  const servers = new Map<string, { label: string; text: string }[]>();
  for (const tool of tools) {
    const text = JSON.stringify(tool);
    const wire = wireName(tool);
    const split = wire === null ? null : splitMcpToolName(nameOf(wire));
    if (split === null) {
      builtin.push(text);
      continue;
    }
    const list = servers.get(split.server) ?? [];
    servers.set(split.server, list);
    list.push({ label: split.rawName, text });
  }
  if (servers.size === 0) return [];
  const measured: MeasuredPart[] = [
    { label: BUILTIN_TOOLS_PART, text: builtin.join(",") },
    ...[...servers].map(([server, list]) => ({
      label: `mcp ${server}`,
      text: list.map((t) => t.text).join(","),
      mcpServer: server,
      tools: list,
    })),
  ];
  return apportionParts(measured, total);
}

/**
 * The prompt input fields for a measured array. Both always travel
 * together, so a caller cannot pass a split that belongs to another
 * array's total.
 */
export function toolSchemaPromptInput(
  measure: ToolSchemaMeasure,
): Pick<BuildPromptInput, "toolSchemaTokens" | "toolSchemaParts"> {
  return {
    toolSchemaTokens: measure.tokens,
    ...(measure.parts.length > 0 ? { toolSchemaParts: measure.parts } : {}),
  };
}

/** OpenAI shape (`{ function: { name } }`), or a flat `{ name }`. */
function wireName(tool: Record<string, unknown>): string | null {
  const fn = tool.function;
  if (fn !== null && typeof fn === "object") {
    const name = (fn as Record<string, unknown>).name;
    if (typeof name === "string") return name;
  }
  return typeof tool.name === "string" ? tool.name : null;
}
