import { ipcMain } from "electron";

import type { AgentClient } from "./agent-client.js";
import { withConfigLock } from "./agent-cli.js";

/**
 * Agent routes that act on the RUNNING agent instead of on the file and a
 * restart: live MCP server control (agent 0.6.6).
 */

/** `MCP_SERVER_NAME_RE` in src/mcp/mcp-types.ts. */
const MCP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

type LiveResult<T> = { ok: true; data: T } | { ok: false; error: string; unsupported?: boolean };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function wireAgentLiveIpc(client: AgentClient): void {
  ipcMain.handle("agent:mcpServer", async (_event, payload: unknown): Promise<LiveResult<unknown>> => {
    const { name, op } = (payload ?? {}) as { name?: unknown; op?: unknown };
    if (typeof name !== "string" || !MCP_NAME_RE.test(name)) return { ok: false, error: "server name required" };
    if (op !== "restart" && op !== "enable" && op !== "disable") return { ok: false, error: "op must be restart, enable or disable" };
    const run = async (): Promise<LiveResult<unknown>> => {
      try {
        const res = await client.mcpServer(name, op);
        return { ok: true, data: res ? res.server ?? null : null };
      } catch (err) {
        const text = message(err);
        // An agent older than 0.6.6 has no such route: http-server.ts answers "No route for POST …".
        if (/^No route for /.test(text)) return { ok: false, unsupported: true, error: text };
        return { ok: false, error: text };
      }
    };
    // enable / disable write `enabled` into config.json, so they take the config lock too.
    return op === "restart" ? run() : withConfigLock(run);
  });
}
