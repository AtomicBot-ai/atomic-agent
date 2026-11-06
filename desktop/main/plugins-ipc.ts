import { ipcMain } from "electron";

import { atagRun, plainCliError, type CliResult } from "./agent-cli.js";
import {
  isUnsupportedPluginCli,
  parsePluginListOutput,
  parsePluginSetRequest,
  pluginCliArgs,
  type PluginListAnswer,
} from "./plugins-cli.js";

/**
 * Settings › Plugins (ATO-954). Three routes, all through the bundled
 * `atag plugin` command (plugins-cli.ts says why):
 *
 *   cli:pluginList  → `atag plugin list --json`
 *   cli:pluginSet   → `atag plugin enable|disable|allow-code|deny-code <name> [--part <id>]`
 *   cli:pluginRemove → `atag plugin remove <name>`
 *
 * Plugin state is its own file, not config.json, so these never take the
 * config lock. Every answer is `{ok: true, ...}` or `{ok: false, error,
 * unsupported?}`; nothing throws at the window.
 */

const UNSUPPORTED = "This agent has no plugin support yet. Update Atomic Agent to manage plugins here.";

function failure(res: CliResult): { ok: false; error: string; unsupported?: boolean } {
  const text = plainCliError(res.stderr) || res.error || "the agent did not answer";
  if (isUnsupportedPluginCli(`${res.stderr}\n${res.error ?? ""}`)) return { ok: false, unsupported: true, error: UNSUPPORTED };
  return { ok: false, error: text };
}

export async function pluginList(): Promise<PluginListAnswer> {
  const res = await atagRun(["plugin", "list", "--json"], 30_000);
  if (!res.ok) return failure(res);
  const parsed = parsePluginListOutput(res.stdout);
  return parsed.ok || !parsed.unsupported ? parsed : { ok: false, unsupported: true, error: UNSUPPORTED };
}

export function wirePluginsIpc(): void {
  ipcMain.handle("cli:pluginList", () => pluginList());

  ipcMain.handle("cli:pluginSet", async (_event, payload: unknown) => {
    const req = parsePluginSetRequest(payload);
    if (!req || req.op === "remove") return { ok: false, error: "plugin name and a valid operation are required" };
    const res = await atagRun(pluginCliArgs(req), 30_000);
    return res.ok ? { ok: true, message: res.stdout.trim() } : failure(res);
  });

  ipcMain.handle("cli:pluginRemove", async (_event, name: unknown) => {
    const req = parsePluginSetRequest({ name, op: "remove" });
    if (!req) return { ok: false, error: "plugin name required" };
    const res = await atagRun(pluginCliArgs(req), 30_000);
    return res.ok ? { ok: true, message: res.stdout.trim() } : failure(res);
  });
}
