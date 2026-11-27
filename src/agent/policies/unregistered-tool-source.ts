/**
 * Where else a tool name the registry does not hold is known (ATO-2423).
 *
 * The unknown-tool streak (`step-unknown-tools.ts`) ends a turn with a
 * `ToolExecutionError` that never carries the invented name. Its
 * `nameClass` says what the name looks like; this says whether the
 * agent itself could have put the name in the model's head:
 *
 * - `prompt_advertised`: the step's tool list (`ctx.toolDescriptors`,
 *   what the prompt and the native tool list are built from) holds it,
 *   yet the registry does not. That is our bug, never a model mistake.
 * - `gated_off`: one of our static catalog tools, switched off here by
 *   config, platform or mode, so the prompt did not show it.
 * - `mcp_server_missing`: an `mcp.<server>.<tool>` name whose server
 *   has no registered tool (down, signed out, or not configured).
 * - `mcp_tool_missing`: the server has registered tools, not this one.
 * - `not_in_catalog`: none of the above, a pure invention.
 *
 * Names are compared in one spelling (case and `.`/`_`/`-` separators
 * folded), as `resolveToolName` folds them. Fixed words only travel;
 * the name itself never does.
 */
import type { UnregisteredToolSource } from "../../llm/index.js";

const MCP_PREFIX = "mcp.";

function fold(name: string): string {
  return name.toLowerCase().replace(/[._-]+/g, ".");
}

/** The server segment of a registered `mcp.<server>.<tool>` name. */
function mcpServerOf(name: string): string | null {
  if (!name.startsWith(MCP_PREFIX)) return null;
  const rest = name.slice(MCP_PREFIX.length);
  const dot = rest.indexOf(".");
  return dot > 0 && dot < rest.length - 1 ? rest.slice(0, dot) : null;
}

export interface UnregisteredToolSourceInput {
  /** The name the model emitted (after `resolveToolName` failed). */
  emitted: string;
  /** Names in the step's tool list (`ctx.toolDescriptors`). */
  advertised: readonly string[];
  /** Names in the static catalog (`DEFAULT_TOOL_DESCRIPTORS`). */
  catalog: readonly string[];
  /** Names the registry holds. */
  registered: readonly string[];
}

export function unregisteredToolSource(
  input: UnregisteredToolSourceInput,
): UnregisteredToolSource {
  const emitted = fold(input.emitted);
  if (input.advertised.some((name) => fold(name) === emitted)) {
    return "prompt_advertised";
  }
  if (input.catalog.some((name) => fold(name) === emitted)) return "gated_off";
  if (!emitted.startsWith(MCP_PREFIX)) return "not_in_catalog";
  for (const name of input.registered) {
    // `mcp.resource.list` and its kin are ours, not a server's.
    if (input.catalog.includes(name)) continue;
    const server = mcpServerOf(name);
    if (server !== null && emitted.startsWith(`${MCP_PREFIX}${fold(server)}.`)) {
      return "mcp_tool_missing";
    }
  }
  return "mcp_server_missing";
}
