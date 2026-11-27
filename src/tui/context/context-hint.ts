import { BUILTIN_TOOLS_PART } from "../../prompt/prompt-breakdown.js";
import type { ContextUsageView } from "./select-context-usage.js";

/**
 * The one piece of advice the context panel gives (ATO-2355).
 *
 * Only small windows get it: on 128k a 10k MCP server is a rounding
 * error, on a 32k local model it is the room the model needed to think.
 * Precedent: Qwen Code's context-cost view names the server and what
 * turning it off would free.
 */
export const HINT_WINDOW_MAX = 65_536;
/** A part above this share of the window is worth a line. */
export const HINT_SHARE = 0.1;

/**
 * The command that turns search mode on. Config is read at start, so it
 * says to restart (ATO-2772: the tip used to name the key, not the way).
 */
export const TOOL_SEARCH_ON_COMMAND =
  "atag config set agent.tools.search on, then restart";

/**
 * Two or three short lines, or `null` when nothing is big enough to mention.
 *
 * An MCP server is the first suspect: it is the one cost the operator
 * added themselves and can take away in one step. The built-in catalog
 * only gets a tip while search mode is off, because search mode is the
 * fix for it and there is nothing else to suggest.
 */
export function contextHint(usage: ContextUsageView): readonly string[] | null {
  const window = usage.contextWindow;
  if (window === null || window <= 0 || window > HINT_WINDOW_MAX) return null;
  const threshold = window * HINT_SHARE;
  const byServer = new Map<string, number>();
  let builtin = 0;
  for (const part of usage.parts) {
    if (part.mcpServer !== undefined) {
      byServer.set(part.mcpServer, (byServer.get(part.mcpServer) ?? 0) + part.tokens);
    } else if (part.label === BUILTIN_TOOLS_PART) {
      builtin += part.tokens;
    }
  }
  let server: string | null = null;
  let serverTokens = 0;
  for (const [name, tokens] of byServer) {
    if (tokens > serverTokens) {
      server = name;
      serverTokens = tokens;
    }
  }
  if (server !== null && serverTokens > threshold) {
    return [
      `tip: mcp ${server} takes ${share(serverTokens, window)}% of the window`,
      ...(usage.toolSearchActive
        ? ["turn the server off in /mcp to free it"]
        : ["turn it off in /mcp, or load tools on demand:", TOOL_SEARCH_ON_COMMAND]),
    ];
  }
  if (!usage.toolSearchActive && builtin > threshold) {
    return [
      `tip: built-in tools take ${share(builtin, window)}% of the window`,
      "to load them on demand, run",
      TOOL_SEARCH_ON_COMMAND,
    ];
  }
  return null;
}

function share(tokens: number, window: number): number {
  return Math.round((tokens / window) * 100);
}
