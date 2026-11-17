import { readFileSync } from "node:fs";
import { BrowserWindow, dialog, ipcMain } from "electron";

import { atagRun, plainCliError, type CliResult } from "./agent-cli.js";
import {
  isInstallableFolderPath,
  isUnsupportedPluginCli,
  parsePluginInstallResult,
  parsePluginListOutput,
  parsePluginSetRequest,
  pluginCliArgs,
  pluginInstallArgs,
  type PluginInstallAnswer,
  type PluginListAnswer,
} from "./plugins-cli.js";

/**
 * Settings › Plugins (ATO-954). Three routes, all through the bundled
 * `atag plugin` command (plugins-cli.ts says why):
 *
 *   cli:pluginList  → `atag plugin list --json`
 *   cli:pluginSet   → `atag plugin enable|disable|allow-code|deny-code <name> [--part <id>]`
 *   cli:pluginRemove → `atag plugin remove <name>`
 *   cli:pluginPickFolder → the native folder picker; main remembers the pick
 *   cli:pluginInstall → `atag plugin install <picked folder> [--yes]`
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

/** Folders the user picked in this run; install takes only these, never a path the window made up. */
const PICKED_MAX = 20;
const picked = new Set<string>();
export function rememberPickedFolder(p: string): void {
  picked.delete(p);
  picked.add(p);
  if (picked.size > PICKED_MAX) picked.delete(picked.values().next().value as string);
}
export function wasPickedFolder(p: unknown): p is string {
  return typeof p === "string" && picked.has(p);
}

/** Smoke runs: `--fake-pick=<json>` with `{"pluginFolder": "/abs/path"}` stands in for the picker. */
function fakePluginFolder(): string | null | undefined {
  const hit = process.argv.find((a) => a.startsWith("--fake-pick="));
  if (!hit) return undefined;
  try {
    const v = (JSON.parse(readFileSync(hit.slice("--fake-pick=".length), "utf8")) as Record<string, unknown>).pluginFolder;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export async function pluginInstall(folder: unknown, confirmCaution: boolean): Promise<PluginInstallAnswer> {
  if (!isInstallableFolderPath(folder) || !wasPickedFolder(folder)) return { ok: false, error: "Pick the plugin folder again." };
  // A copy plus the security scan of every file: longer than a switch, never minutes.
  const res = await atagRun(pluginInstallArgs(folder, confirmCaution), 120_000);
  if (!res.ok && !res.stderr && res.error) return { ok: false, error: plainCliError(res.error) || res.error };
  return parsePluginInstallResult(res);
}

export function wirePluginsIpc(): void {
  ipcMain.handle("cli:pluginList", () => pluginList());

  ipcMain.handle("cli:pluginSet", async (_event, payload: unknown) => {
    const req = parsePluginSetRequest(payload);
    if (!req || req.op === "remove") return { ok: false, error: "plugin name and a valid operation are required" };
    const res = await atagRun(pluginCliArgs(req), 30_000);
    return res.ok ? { ok: true, message: res.stdout.trim() } : failure(res);
  });

  ipcMain.handle("cli:pluginPickFolder", async (event) => {
    const fake = fakePluginFolder();
    let folder: string | null = null;
    if (fake !== undefined) folder = fake;
    else {
      const win = BrowserWindow.fromWebContents(event.sender);
      const opts = {
        title: "Choose a plugin folder",
        message: "Choose the folder that holds the plugin (the one with .claude-plugin/, plugin.json, skills/ or commands/ inside).",
        buttonLabel: "Install",
        properties: ["openDirectory"] as Array<"openDirectory">,
      };
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      folder = res.canceled ? null : res.filePaths[0] ?? null;
    }
    if (!isInstallableFolderPath(folder)) return { ok: true, folder: null };
    rememberPickedFolder(folder);
    return { ok: true, folder };
  });

  ipcMain.handle("cli:pluginInstall", (_event, payload: unknown) => {
    const { folder, confirmCaution } = (payload ?? {}) as { folder?: unknown; confirmCaution?: unknown };
    return pluginInstall(folder, confirmCaution === true);
  });

  ipcMain.handle("cli:pluginRemove", async (_event, name: unknown) => {
    const req = parsePluginSetRequest({ name, op: "remove" });
    if (!req) return { ok: false, error: "plugin name required" };
    const res = await atagRun(pluginCliArgs(req), 30_000);
    return res.ok ? { ok: true, message: res.stdout.trim() } : failure(res);
  });
}
