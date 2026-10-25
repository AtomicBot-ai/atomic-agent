/**
 * Dynamic GBNF fragment generator for MCP-namespaced tool names.
 *
 * The static grammar in `grammars/tool-call.gbnf` defines a
 * `mcp-server-tool` placeholder rule but does not reference it from
 * `tool-name`, so with no MCP tools the sampler can emit no
 * `mcp.<server>.<tool>` name at all. A grammar-constrained local model
 * used to invent one (`mcp.example.toolkit`) through a permissive
 * placeholder, and the turn died on "tool not registered" (ATO-1029).
 * At bootstrap — and after every successful `McpManager.refreshCatalog`
 * — the runtime regenerates the rule with the actual list of qualified
 * names and references it from `tool-name`, so the LLM can only emit
 * names that resolve to a registered `ToolDefinition`.
 *
 * Touching this rule **invalidates the main agent slot's KV cache
 * for one inference** (the grammar bytes change). The same cost
 * applies to skill install / uninstall. Acceptable because the
 * operation is rare (server connect / disconnect, never per turn).
 */

import type { McpToolMeta } from "./mcp-types.js";

/** The `mcp-server-tool` definition (the static placeholder or a dynamic list). */
const PLACEHOLDER_RULE_RE = /^mcp-server-tool ::= .+$/m;

/** The `tool-name` rule, whose alternation references `mcp-server-tool` only while MCP tools exist. */
const TOOL_NAME_RULE_RE = /^tool-name ::= .*$/m;

const MCP_SERVER_TOOL = "mcp-server-tool";
const MCP_NATIVE_TOOL = "mcp-native-tool";
/** Where each reference goes back, so the rule reads as it did before ATO-1029. */
const REFERENCE_ANCHOR: Readonly<Record<string, string>> = {
  [MCP_SERVER_TOOL]: MCP_NATIVE_TOOL,
  [MCP_NATIVE_TOOL]: "verify-tool",
};

/**
 * Build the dynamic `mcp-server-tool` rule body as a GBNF
 * alternation over every known qualified MCP tool name. Returns
 * `null` when the input is empty — the caller then gets a grammar
 * that admits no `mcp.<server>.<tool>` name.
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
 * Patch the rendered grammar for the current MCP catalog. With a
 * dynamic rule: the `mcp-server-tool` definition is replaced and
 * `tool-name` references it. With `null` (no MCP tools): `tool-name`
 * drops the reference, so no per-server MCP name can be sampled; the
 * definition stays, unreferenced, which llama.cpp still parses.
 *
 * `nativeTools` says whether the four `mcp.resource.*` / `mcp.prompt.*`
 * tools are registered: they are only when MCP is on (a server is
 * configured or was added live) and are never unregistered, so they
 * stay after the last server is removed live (`registerMcpMetaToolsOnce`
 * in the runtime catalog). With MCP off from the start `mcp-native-tool`
 * is dropped from `tool-name` too and no `mcp.*` name can be sampled. Every direction is idempotent, so a grammar already patched
 * can be patched again.
 */
export function applyMcpToolNameRule(
  grammar: string,
  rule: string | null,
  nativeTools = true,
): string {
  const withNative = setToolNameReference(grammar, MCP_NATIVE_TOOL, nativeTools);
  return applyServerToolRule(withNative, rule);
}

function applyServerToolRule(grammar: string, rule: string | null): string {
  if (!rule) return setToolNameReference(grammar, MCP_SERVER_TOOL, false);
  if (!PLACEHOLDER_RULE_RE.test(grammar)) {
    // Static grammar must declare the placeholder. If it's missing
    // (e.g. someone shipped an older grammar file) we append the
    // rule at the end — GBNF treats it as a fresh definition and
    // overrides any earlier mention. This keeps us fail-open
    // instead of silently dropping MCP tool calls.
    return setToolNameReference(`${grammar.trimEnd()}\n${rule}\n`, MCP_SERVER_TOOL, true);
  }
  return setToolNameReference(grammar.replace(PLACEHOLDER_RULE_RE, rule), MCP_SERVER_TOOL, true);
}

function setToolNameReference(grammar: string, ref: string, referenced: boolean): string {
  return grammar.replace(TOOL_NAME_RULE_RE, (line) => {
    const alternatives = line
      .slice("tool-name ::= ".length)
      .split("|")
      .map((alt) => alt.trim())
      .filter((alt) => alt.length > 0);
    const present = alternatives.includes(ref);
    if (present === referenced) return line;
    if (!referenced) {
      return `tool-name ::= ${alternatives.filter((alt) => alt !== ref).join(" | ")}`;
    }
    const at = alternatives.indexOf(REFERENCE_ANCHOR[ref] ?? "");
    alternatives.splice(at === -1 ? alternatives.length : at + 1, 0, ref);
    return `tool-name ::= ${alternatives.join(" | ")}`;
  });
}
