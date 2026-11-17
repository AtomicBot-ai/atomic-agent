/**
 * Settings › Plugins talks to the agent's own `atag plugin` command, so the
 * agent stays the only writer of `<stateDir>/plugins/plugins.json` (the file
 * the terminal shares) and the screen shows exactly what the terminal's
 * `/plugins` panel shows: `plugin list --json` prints the agent's shared
 * `PluginOverview` (src/plugins/plugin-overview.ts).
 *
 * This file is pure: argument building, input checks and output parsing.
 * plugins-ipc.ts runs the commands.
 *
 * An agent without the plugin command answers `unknown command: plugin`
 * (exit 2); one with the loader but without `--json` prints its text table.
 * Both become `{unsupported: true}`, so the screen says "update the agent"
 * and offers no switches: an agent that old would read `--part` as noise
 * and switch the whole plugin.
 */

import { isAbsolute } from "node:path";

/** `PLUGIN_NAME_RE` in src/plugins/plugin-manifest.ts: kebab-case, at most 64. */
export const PLUGIN_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** Part ids `setPluginPartEnabled` takes; `PART_ID_RE` in src/cli/plugin-command.ts. */
export const PLUGIN_PART_RE = /^(skill|mcp|hook|command|agent):[^\s]{1,200}$/;

export type PluginOp = "enable" | "disable" | "allow-code" | "deny-code" | "remove";
const OPS: readonly PluginOp[] = ["enable", "disable", "allow-code", "deny-code", "remove"];

export interface PluginSetRequest {
  name: string;
  op: PluginOp;
  /** Only with enable / disable: switch one part instead of the plugin. */
  part?: string;
}

/** Check what the window sent; `null` when it is not a request this screen makes. */
export function parsePluginSetRequest(payload: unknown): PluginSetRequest | null {
  const { name, op, part } = (payload ?? {}) as { name?: unknown; op?: unknown; part?: unknown };
  if (typeof name !== "string" || !PLUGIN_NAME_RE.test(name)) return null;
  if (typeof op !== "string" || !(OPS as readonly string[]).includes(op)) return null;
  if (part === undefined || part === null) return { name, op: op as PluginOp };
  if (typeof part !== "string" || !PLUGIN_PART_RE.test(part)) return null;
  if (op !== "enable" && op !== "disable") return null;
  return { name, op, part };
}

/** The argv for one request. Always an array, never a shell string. */
export function pluginCliArgs(req: PluginSetRequest): string[] {
  const args = ["plugin", req.op, req.name];
  if (req.part) args.push("--part", req.part);
  return args;
}

export type PluginListAnswer =
  | { ok: true; plugins: unknown[] }
  | { ok: false; error: string; unsupported?: boolean };

/** True when the agent does not know `plugin`, or `plugin list --json`, yet. */
export function isUnsupportedPluginCli(text: string): boolean {
  return /unknown (?:sub)?command: plugin\b/i.test(text);
}

/**
 * Parse `atag plugin list --json`. The JSON is the last line that starts
 * with `{`: anything the agent prints before it (a notice) is not ours.
 */
export function parsePluginListOutput(stdout: string): PluginListAnswer {
  const line = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
  if (!line) {
    // An agent whose `plugin list` predates --json prints its text table instead.
    return { ok: false, unsupported: true, error: "This agent does not report plugins to the app yet." };
  }
  try {
    const doc = JSON.parse(line) as { plugins?: unknown };
    if (!Array.isArray(doc.plugins)) return { ok: false, error: "The agent answered without a plugin list." };
    return { ok: true, plugins: doc.plugins.filter((p) => p !== null && typeof p === "object") };
  } catch {
    return { ok: false, error: "The agent's plugin list could not be read." };
  }
}

/* ---- Install from folder (Settings › Plugins' "Install from folder…") ----
   The window never names a path of its own: main opens the folder picker,
   remembers what was picked, and installs only a remembered folder through
   the same `atag plugin install <folder>` the terminal uses. So the copy,
   the security scan and the runs-code rule are the agent's, unchanged:
   without a terminal a caution finding needs `--yes` (the window's
   "Install anyway"), a dangerous one is refused, and parts that run code
   install switched off until "Allow code…". */

/** A folder path main may hand to `plugin install`: absolute, one line, never read as a flag. */
export function isInstallableFolderPath(p: unknown): p is string {
  return typeof p === "string" && p.length > 0 && p.length <= 4096 && isAbsolute(p) && !p.startsWith("-") && !/[\0\r\n]/.test(p);
}

/** The argv for one install. `--yes` only after the user said "Install anyway" to a caution finding. */
export function pluginInstallArgs(folder: string, confirmCaution: boolean): string[] {
  const args = ["plugin", "install", folder];
  if (confirmCaution) args.push("--yes");
  return args;
}

export type PluginInstallAnswer =
  | { ok: true; name: string | null; message: string; runsCode: boolean; startsServers: boolean }
  | { ok: false; error: string; needsConfirmation?: boolean; blocked?: boolean; findings?: string[]; unsupported?: boolean };

const SCAN_FINDING_RE = /^\s*\[(?:caution|dangerous|danger|warn|warning|info)\]\s+\S/i;

/**
 * Read what `atag plugin install <folder>` said. Success prints
 * `Installed <name>@<version>: <what it brings>` first; a refusal ends
 * stderr with one summary line (src/cli/plugin-command.ts reportError),
 * after the scan's findings when the scan stopped it.
 */
export function parsePluginInstallResult(res: { ok: boolean; stdout: string; stderr: string; error?: string }): PluginInstallAnswer {
  if (res.ok) {
    const lines = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const head = lines.find((l) => l.startsWith("Installed ")) ?? lines[0] ?? "Installed.";
    const name = /^Installed ([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)@/.exec(head)?.[1] ?? null;
    return {
      ok: true,
      name,
      message: head,
      runsCode: lines.some((l) => l.startsWith("This plugin can run programs")),
      startsServers: /\bMCP servers?\b/.test(head),
    };
  }
  const stderr = res.stderr ?? "";
  if (isUnsupportedPluginCli(`${stderr}\n${res.error ?? ""}`)) {
    return { ok: false, unsupported: true, error: "This agent has no plugin support yet. Update Atomic Agent to install plugins here." };
  }
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const findings = lines.filter((l) => SCAN_FINDING_RE.test(l)).slice(0, 8);
  const last = lines.filter((l) => !/^\s*at\s/.test(l) && !/^Node\.js v\d/.test(l)).pop() ?? res.error ?? "the agent did not answer";
  if (/^install needs confirmation\b/i.test(last)) {
    return { ok: false, needsConfirmation: true, findings, error: "The security scan flagged something in this plugin. Read what it found before you install it anyway." };
  }
  if (/^install blocked\b/i.test(last)) {
    return { ok: false, blocked: true, findings, error: "Not installed: the security scan marked this plugin as dangerous." };
  }
  const already = /^plugin ([a-z0-9-]+) is already installed\b/.exec(last);
  if (already) return { ok: false, error: `${already[1]} is already installed. Remove it first to install this copy.` };
  if (/\bis not a plugin\b/.test(last)) {
    return { ok: false, error: "This folder is not a plugin: it has no .claude-plugin/plugin.json, plugin.json, skills/ or commands/ inside." };
  }
  return { ok: false, error: last };
}
