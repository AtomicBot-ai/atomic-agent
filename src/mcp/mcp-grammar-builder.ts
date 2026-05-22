/**
 * Dynamic GBNF fragment generator for MCP-namespaced tool names.
 *
 * The static grammar in `grammars/tool-call.gbnf` reserves a
 * `mcp-server-tool` rule with a permissive shape
 * (`"\"mcp." [a-z0-9-]+ "." [a-zA-Z0-9._-]+ "\""`). At bootstrap
 * — and after every successful `McpManager.refreshCatalog` — the
 * runtime regenerates this rule with the actual list of qualified
 * names so the LLM can only emit names that resolve to a registered
 * `ToolDefinition`.
 *
 * When no MCP tools are registered, `buildMcpToolNameRule` returns
 * `null` and the caller leaves the static permissive rule alone —
 * this is also the right behaviour for hosts that disable MCP
 * entirely.
 *
 * Touching this rule **invalidates the main agent slot's KV cache
 * for one inference** (the grammar bytes change). The same cost
 * applies to skill install / uninstall. Acceptable because the
 * operation is rare (server connect / disconnect, never per turn).
 */

import type { McpToolMeta } from "./mcp-types.js";

/** Static placeholder rule baked into `grammars/tool-call.gbnf`. */
const PLACEHOLDER_RULE_RE =
  /^mcp-server-tool ::= .+$/m;

/**
 * Build the dynamic `mcp-server-tool` rule body as a GBNF
 * alternation over every known qualified MCP tool name. Returns
 * `null` when the input is empty — the caller keeps the static
 * permissive rule (which still accepts `mcp.*.*` so a hot-added
 * server is parseable until the next grammar rebuild).
 *
 * The names are deduplicated and sorted so the same input always
 * produces the same bytes — load-bearing for KV-cache stability.
 */
export function buildMcpToolNameRule(
  metas: readonly McpToolMeta[],
): string | null {
  if (metas.length === 0) return null;
  const names = Array.from(new Set(metas.map((m) => m.qualifiedName))).sort();
  if (names.length === 0) return null;
  const literals = names.map((n) => `"\\"${n}\\""`).join(" | ");
  return `mcp-server-tool ::= ${literals}`;
}

/**
 * Patch the rendered grammar by replacing the placeholder
 * `mcp-server-tool` rule with the dynamic alternation. Returns the
 * grammar unchanged when no dynamic rule was provided.
 */
export function applyMcpToolNameRule(
  grammar: string,
  rule: string | null,
): string {
  if (!rule) return grammar;
  if (!PLACEHOLDER_RULE_RE.test(grammar)) {
    // Static grammar must declare the placeholder. If it's missing
    // (e.g. someone shipped an older grammar file) we append the
    // rule at the end — GBNF treats it as a fresh definition and
    // overrides any earlier mention. This keeps us fail-open
    // instead of silently dropping MCP tool calls.
    return `${grammar.trimEnd()}\n${rule}\n`;
  }
  return grammar.replace(PLACEHOLDER_RULE_RE, rule);
}
