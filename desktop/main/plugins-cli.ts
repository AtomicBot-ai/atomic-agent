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
