import { readFileSync, statSync } from "node:fs";
import { bundleRunsCode, readPluginBundle } from "./plugin-bundle.js";
import { installedPluginDir, isPartDisabled, readPluginState, type InstalledPluginRecord, type PluginSourceRecord } from "./plugin-store.js";
import type { PluginBundle, PluginFormat } from "./plugin-types.js";

/**
 * One view model of an installed plugin, shared by the terminal `/plugins`
 * panel, `atomic-agent plugin list --json` and the desktop Plugins screen,
 * so the three never count or label a plugin differently.
 *
 * `buildPluginOverview` is pure: it takes the install record, the parsed
 * bundle (or the reason it could not be read), the hook event names and an
 * environment, and returns plain data. `loadPluginOverviews` is the one
 * place here that touches the disk.
 */

export type PluginPartKind = "skill" | "mcp" | "hook" | "command" | "agent";

/**
 * What the user has agreed to about code:
 * - `no-code`: nothing in the plugin can run a command, nothing to agree to.
 * - `code-allowed`: it can run code and the user said yes (`runsCodeAccepted`,
 *   `atomic-agent plugin allow-code`).
 * - `code-off`: it can run code and nobody has said yes, so its local MCP
 *   servers, hooks and skill scripts stay off; everything else works.
 */
export type PluginTrust = "no-code" | "code-allowed" | "code-off";

export interface PluginPartOverview {
  /** The id `setPluginPartEnabled` takes: `skill:x`, `mcp:x`, `hook:Event`, `command:x`, `agent:x`. */
  id: string;
  kind: PluginPartKind;
  name: string;
  /** The part's own switch; the plugin's switch is separate (`PluginOverview.enabled`). */
  enabled: boolean;
  /** This part alone can run a command (skill scripts, stdio MCP server, any hook). */
  runsCode: boolean;
  /**
   * Whether the part is in use right now: the plugin is on, the part is on,
   * and, if it runs code, the user allowed code for this plugin.
   */
  active: boolean;
  /** Variables or settings this MCP server needs and does not have. Empty for every other kind. */
  missingKeys: string[];
}

export interface PluginCounts {
  skills: number;
  mcpServers: number;
  hooks: number;
  commands: number;
  agents: number;
}

export interface PluginOverview {
  name: string;
  version: string;
  description: string;
  format: PluginFormat | null;
  source: PluginSourceRecord;
  /** Short plain-language source, e.g. `folder ~/x`, `marketplace acme`. */
  sourceLabel: string;
  enabled: boolean;
  /** False when the plugin folder is missing or no longer parses; `error` says why. */
  filesOk: boolean;
  error: string | null;
  counts: PluginCounts;
  runsCode: boolean;
  trust: PluginTrust;
  /** Plain list of what would run, e.g. `local MCP servers: gh`, `hooks` (see `pluginCodeParts`). */
  codeParts: string[];
  /** At least one switched-on MCP server is missing a key. */
  needsKey: boolean;
  /** Union of `missingKeys` over switched-on parts, sorted. */
  missingKeys: string[];
  parts: PluginPartOverview[];
  notes: string[];
  installedAt: string;
  updatedAt: string;
}

export interface BuildPluginOverviewOptions {
  /** Environment used for the "needs a key" check. Defaults to an empty one (every reference is missing). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Hook event names (`PreToolUse`, ...), from `readPluginHookEvents`. */
  hookEvents?: readonly string[];
  /** Why the bundle could not be read, when `bundle` is null. */
  bundleError?: string;
}

const PLUGIN_VARS = new Set(["CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "PLUGIN_ROOT", "PLUGIN_DATA"]);
const VAR_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g;

export function buildPluginOverview(
  record: InstalledPluginRecord,
  bundle: PluginBundle | null,
  options: BuildPluginOverviewOptions = {},
): PluginOverview {
  const env = options.env ?? {};
  const base = {
    name: record.name,
    version: record.version,
    source: record.source,
    sourceLabel: describePluginSource(record.source),
    enabled: record.enabled,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
  };
  if (!bundle) {
    return {
      ...base,
      description: "",
      format: null,
      filesOk: false,
      error: options.bundleError ?? "plugin files are missing or unreadable",
      counts: { skills: 0, mcpServers: 0, hooks: 0, commands: 0, agents: 0 },
      runsCode: false,
      trust: "no-code",
      codeParts: [],
      needsKey: false,
      missingKeys: [],
      parts: [],
      notes: [],
    };
  }

  const on = (id: string) => !isPartDisabled(record, id);
  const parts: PluginPartOverview[] = [];
  for (const skill of bundle.skills) {
    const name = skill.name || bundle.name;
    const id = `skill:${name}`;
    parts.push({ id, kind: "skill", active: false, name, enabled: on(id), runsCode: skill.hasScripts, missingKeys: [] });
  }
  for (const [name, entry] of Object.entries(bundle.mcpServers)) {
    const id = `mcp:${name}`;
    parts.push({ id, kind: "mcp", active: false, name, enabled: on(id), runsCode: typeof entry.command === "string", missingKeys: missingMcpKeys(entry, env) });
  }
  const hookEvents = [...new Set(options.hookEvents ?? [])].sort();
  for (const event of hookEvents) {
    const id = `hook:${event}`;
    parts.push({ id, kind: "hook", active: false, name: event, enabled: on(id), runsCode: true, missingKeys: [] });
  }
  for (const command of bundle.commands) {
    const id = `command:${command.name}`;
    parts.push({ id, kind: "command", active: false, name: command.name, enabled: on(id), runsCode: false, missingKeys: [] });
  }
  for (const agent of bundle.agents) {
    const id = `agent:${agent.name}`;
    parts.push({ id, kind: "agent", active: false, name: agent.name, enabled: on(id), runsCode: false, missingKeys: [] });
  }

  const runsCode = bundleRunsCode(bundle) || hookEvents.length > 0;
  const codeAllowed = record.runsCodeAccepted === true;
  for (const part of parts) part.active = record.enabled && part.enabled && (!part.runsCode || codeAllowed);
  const missingKeys = [...new Set(parts.filter(p => p.enabled).flatMap(p => p.missingKeys))].sort();
  return {
    ...base,
    description: bundle.manifest.description,
    format: bundle.format,
    filesOk: true,
    error: null,
    counts: {
      skills: bundle.skills.length,
      mcpServers: Object.keys(bundle.mcpServers).length,
      // A hooks file we could not read still counts as "has hooks".
      hooks: hookEvents.length || (bundle.hooksFile || bundle.manifest.hooksInline ? 1 : 0),
      commands: bundle.commands.length,
      agents: bundle.agents.length,
    },
    runsCode,
    trust: pluginTrust(runsCode, codeAllowed),
    codeParts: pluginCodeParts(bundle),
    needsKey: missingKeys.length > 0,
    missingKeys,
    parts,
    notes: [...bundle.notes],
  };
}

export function pluginTrust(runsCode: boolean, accepted: boolean): PluginTrust {
  if (!runsCode) return "no-code";
  return accepted ? "code-allowed" : "code-off";
}

/** Plain list of what would run on this computer, for consent lines in the CLI and both UIs. */
export function pluginCodeParts(b: PluginBundle): string[] {
  const out: string[] = [];
  const stdio = Object.entries(b.mcpServers).filter(([, s]) => typeof s.command === "string").map(([n]) => n);
  if (stdio.length) out.push(`local MCP servers: ${stdio.join(", ")}`);
  if (b.hooksFile || b.manifest.hooksInline) out.push("hooks");
  const scripted = b.skills.filter(s => s.hasScripts).map(s => s.name || b.name);
  if (scripted.length) out.push(`skill scripts: ${scripted.join(", ")}`);
  return out;
}

/**
 * Keys an MCP server entry needs and does not have: every `${VAR}` in its
 * `env`, `headers` or `url` whose variable is unset or empty in `env`
 * (`${VAR:-default}` has a fallback and never counts), plus every `env` /
 * `headers` field left empty. Plugin path variables are filled in by the
 * loader and never count. Returns names only, never values.
 */
export function missingMcpKeys(entry: Record<string, unknown>, env: Readonly<Record<string, string | undefined>>): string[] {
  const missing = new Set<string>();
  const scan = (value: string) => {
    for (const match of value.matchAll(VAR_REF_RE)) {
      const name = match[1]!;
      if (PLUGIN_VARS.has(name) || match[2] !== undefined) continue;
      if (!env[name]) missing.add(name);
    }
  };
  for (const field of ["env", "headers"] as const) {
    const map = entry[field];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      if (value.trim() === "") missing.add(key);
      else scan(value);
    }
  }
  if (typeof entry.url === "string") scan(entry.url);
  return [...missing].sort();
}

/**
 * Event names in a hooks document. Accepts the `hooks/hooks.json` shape
 * (`{ "hooks": { "PreToolUse": [...] } }`) and a bare event map, which is
 * how inline `hooks` in plugin.json are often written.
 */
export function hookEventNames(doc: unknown): string[] {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return [];
  const obj = doc as Record<string, unknown>;
  const map = obj.hooks && typeof obj.hooks === "object" && !Array.isArray(obj.hooks) ? (obj.hooks as Record<string, unknown>) : obj;
  return Object.entries(map)
    .filter(([key, value]) => key !== "description" && Array.isArray(value))
    .map(([key]) => key)
    .sort();
}

const MAX_HOOKS_BYTES = 512 * 1024;

/** Hook event names from a bundle's hooks file and inline hooks. An unreadable file reads as none. */
export function readPluginHookEvents(bundle: PluginBundle): string[] {
  const events = new Set<string>(hookEventNames(bundle.manifest.hooksInline));
  if (bundle.hooksFile) {
    try {
      if (statSync(bundle.hooksFile).size <= MAX_HOOKS_BYTES) {
        for (const e of hookEventNames(JSON.parse(readFileSync(bundle.hooksFile, "utf8")))) events.add(e);
      }
    } catch {
      // A broken hooks file is the hooks loader's diagnostic; here it is just "has hooks".
    }
  }
  return [...events].sort();
}

export function describePluginSource(source: PluginSourceRecord): string {
  switch (source.kind) {
    case "local": return `folder ${source.path}`;
    case "marketplace": return `marketplace ${source.marketplace}`;
    case "git": return `git ${source.url}`;
    default: return "unknown";
  }
}

/** Every installed plugin as an overview, sorted by name. Reads the state file and each plugin folder. */
export function loadPluginOverviews(stateDir: string, env: Readonly<Record<string, string | undefined>> = process.env): PluginOverview[] {
  const records = Object.values(readPluginState(stateDir).plugins).sort((a, b) => a.name.localeCompare(b.name));
  return records.map(record => loadPluginOverview(stateDir, record, env));
}

export function loadPluginOverview(stateDir: string, record: InstalledPluginRecord, env: Readonly<Record<string, string | undefined>> = process.env): PluginOverview {
  let bundle: PluginBundle;
  try {
    bundle = readPluginBundle(installedPluginDir(stateDir, record.name));
  } catch (err) {
    return buildPluginOverview(record, null, { env, bundleError: err instanceof Error ? err.message : String(err) });
  }
  return buildPluginOverview(record, bundle, { env, hookEvents: readPluginHookEvents(bundle) });
}

/** "2 skills, 1 MCP server, 3 hooks" — the counts in one line, or "empty". */
export function formatPluginCounts(counts: PluginCounts): string {
  const parts: Array<[number, string]> = [
    [counts.skills, "skill"],
    [counts.mcpServers, "MCP server"],
    [counts.hooks, "hook"],
    [counts.commands, "command"],
    [counts.agents, "subagent"],
  ];
  const text = parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`);
  return text.length ? text.join(", ") : "empty";
}
