/**
 * Descriptor builder for MCP-namespaced tools.
 *
 * Every MCP tool is rendered as **tier: "frequent"** — the full
 * `argsSchema` lands in `# common (full)` of `### tools` so the model
 * sees the signature on the very first call, without an intervening
 * `tool.view`. This is a deliberate trade-off (see AGENTS.md §"MCP
 * client" invariant 5): we pay a one-time bump in stable-prefix
 * tokens proportional to the connected MCP catalog in exchange for
 * the model actually being able to *call* MCP tools without an
 * extra round-trip. The earlier `rare`-tier rendering surfaced only
 * a one-liner under `# extras`, which in practice meant smaller
 * local models almost never invoked MCP tools — they were visible
 * but unusable without a `tool.view` step the model rarely thought
 * to take.
 *
 * The native `mcp.resource.*` / `mcp.prompt.*` discovery tools come
 * from `DEFAULT_TOOL_DESCRIPTORS` (declared inline) — also
 * `frequent`, unchanged.
 *
 * Trade-off acknowledged: a hostile / chatty MCP server can balloon
 * the stable prefix. Operators wiring up untrusted servers should
 * weigh that against the discoverability win. There is no per-server
 * tier override today.
 */

import type { ToolDescriptor } from "../prompt/stable-prefix.js";

import type { McpToolMeta } from "./mcp-types.js";

/** Cap on `argsSchema` rendering. Long schemas land truncated in `### loaded-tools`. */
const MAX_ARGS_SCHEMA_CHARS = 2_000;
/** Cap on `summary` length to keep the rare-tool one-liner readable. */
const MAX_SUMMARY_CHARS = 200;

/**
 * Build a `ToolDescriptor` for a single MCP tool. Ships at tier
 * `frequent` so the full schema is rendered into the stable prefix
 * — see the module-level comment for the rationale.
 */
export function buildMcpToolDescriptor(meta: McpToolMeta): ToolDescriptor {
  const summaryBody = meta.description
    ? truncate(stripNewlines(meta.description), MAX_SUMMARY_CHARS)
    : `MCP ${meta.rawName} on ${meta.server}`;
  return {
    name: meta.qualifiedName,
    summary: `[mcp:${meta.server}] ${summaryBody}`,
    argsSchema: renderArgsSchema(meta.inputSchema),
    tier: "frequent",
    ...(meta.inputSchema
      ? { argsJsonSchema: meta.inputSchema as Record<string, unknown> }
      : {}),
  };
}

/**
 * Build descriptors for every tool the manager currently knows
 * about. Returns an array in stable order (server-then-tool, both
 * alphabetical) so the stable prefix hash is deterministic across
 * runs.
 */
export function buildMcpToolDescriptors(
  metas: readonly McpToolMeta[],
): ToolDescriptor[] {
  const sorted = [...metas].sort((a, b) => {
    if (a.server !== b.server) return a.server < b.server ? -1 : 1;
    return a.rawName < b.rawName ? -1 : a.rawName > b.rawName ? 1 : 0;
  });
  return sorted.map(buildMcpToolDescriptor);
}

/**
 * Merge MCP tool descriptors with the base list. MCP descriptors
 * are appended at the end so the native catalog ordering stays
 * stable. Duplicates (by `name`) keep the **MCP** entry — if a
 * native tool ever collides with an MCP-namespaced name something
 * is structurally wrong and we surface the dynamic side.
 */
export function mergeMcpDescriptors(
  base: readonly ToolDescriptor[],
  mcp: readonly ToolDescriptor[],
): ToolDescriptor[] {
  if (mcp.length === 0) return [...base];
  const mcpNames = new Set(mcp.map((d) => d.name));
  const out: ToolDescriptor[] = [];
  for (const d of base) {
    if (!mcpNames.has(d.name)) out.push(d);
  }
  out.push(...mcp);
  return out;
}

/**
 * Project an MCP input-schema (JSON Schema fragment) into the
 * codebase's compact TS-ish argsSchema string. Falls back to
 * `(see schema)` when the schema is empty / null — the agent will
 * still see the tool name and can call `tool.view` to fetch the
 * raw JSON Schema if needed.
 */
function renderArgsSchema(schema: Record<string, unknown> | null): string {
  if (!schema) return "{}";
  try {
    const json = JSON.stringify(schema);
    return truncate(json, MAX_ARGS_SCHEMA_CHARS);
  } catch {
    return "{}";
  }
}

function stripNewlines(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
