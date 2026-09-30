import { ipcMain } from "electron";

import type { AgentClient } from "./agent-client.js";
import { withConfigLock } from "./agent-cli.js";

/**
 * Agent routes that act on the RUNNING agent instead of on the file and a
 * restart: live MCP server control and the deep-merge config patch. Both
 * arrived in agent 0.6.6.
 *
 * The one hazard is an older agent. Its `PATCH /api/config` was a shallow
 * merge that rebuilt the file from four blocks and silently dropped the
 * rest (`llm`, `mcp`, `telegram`, ...). So a patch is only sent after
 * `/health` proves the agent is 0.6.6 or newer: `busyTurns` shipped in the
 * same release as the deep merge and is always present on loopback. When
 * the check fails the answer is `{ok:false, unsupported:true}` and the
 * renderer falls back to the CLI write it used before.
 */

/** `MCP_SERVER_NAME_RE` in src/mcp/mcp-types.ts. */
const MCP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

type LiveResult<T> = { ok: true; data: T } | { ok: false; error: string; unsupported?: boolean };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** True when the agent answering is 0.6.6+ (see the note above). */
export async function agentHasLiveRoutes(client: AgentClient): Promise<boolean> {
  try {
    const health = (await client.health()) as { busyTurns?: unknown } | null;
    return typeof health?.busyTurns === "number";
  } catch {
    return false;
  }
}

export function wireAgentLiveIpc(client: AgentClient): void {
  /* The patch queues on the same lock as every CLI config write, so it
     cannot interleave with a whole-file write in flight. */
  ipcMain.handle("agent:configPatch", (_event, patch: unknown): Promise<LiveResult<unknown>> => {
    if (!isPlainObject(patch)) return Promise.resolve({ ok: false, error: "patch must be an object" });
    return withConfigLock(async (): Promise<LiveResult<unknown>> => {
      if (!(await agentHasLiveRoutes(client))) {
        return { ok: false, unsupported: true, error: "this agent cannot merge config live" };
      }
      try {
        return { ok: true, data: await client.patchConfig(patch) };
      } catch (err) {
        return { ok: false, error: message(err) };
      }
    });
  });

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
