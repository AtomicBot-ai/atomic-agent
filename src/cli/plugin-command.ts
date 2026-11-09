import { getConfig } from "../config/index.js";
import {
  bundleRunsCode,
  installPluginFromDir,
  installedPluginDir,
  loadPluginOverview,
  loadPluginOverviews,
  pluginCodeParts,
  PluginInstallError,
  PluginManifestError,
  readPluginBundle,
  readPluginState,
  removePlugin,
  resetPluginCache,
  setPluginCodeAllowed,
  setPluginEnabled,
  setPluginPartEnabled,
  type PluginBundle,
} from "../plugins/index.js";

const HELP = [
  "atomic-agent plugin — manage plugins (Claude / Codex / Cursor plugin packages)",
  "",
  "Subcommands:",
  "  list [--json]              List installed plugins with what each one brings",
  "  show <name> [--json]       Print a plugin's skills, commands, MCP servers, hooks and notes",
  "  install <path> [--force] [--accept-code]",
  "                             Install a plugin from a local folder (copied into the data folder).",
  "                             Parts that run programs or receive your keys (local MCP servers, hooks,",
  "                             scripts, servers that read a key) stay off",
  "                             until you allow them: --accept-code here, or allow-code later",
  "  allow-code <name>          Let a plugin run its local MCP servers, hooks and scripts and receive your keys",
  "  deny-code <name>           Switch those parts off again (skills and remote servers keep working)",
  "  enable <name> [--part <id>]",
  "                             Switch an installed plugin on, or one of its parts",
  "  disable <name> [--part <id>]",
  "                             Switch a plugin (or one part) off without removing it.",
  "                             Part ids: skill:<name>, mcp:<name>, hook:<Event>, command:<name>, agent:<name>",
  "  remove <name>              Uninstall a plugin and delete its files",
  "",
  "Plugins live in <data folder>/plugins and are shared with the desktop app.",
  "Skills appear as plugin:skill. MCP servers start on the next agent start.",
  "--json prints the same overview the /plugins panel and the desktop Plugins screen show.",
].join("\n");

export async function pluginCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(HELP);
    return sub ? 0 : 2;
  }
  const stateDir = getConfig().paths.stateDir;
  try {
    switch (sub) {
      case "list": return rest.includes("--json") ? listJson(stateDir) : list(stateDir);
      case "show": {
        const name = rest.find(a => !a.startsWith("--"));
        return rest.includes("--json") ? showJson(stateDir, name) : show(stateDir, name);
      }
      case "install": return install(stateDir, rest);
      case "enable":
      case "disable": return toggle(stateDir, rest, sub === "enable");
      case "allow-code":
      case "deny-code": return code(stateDir, rest[0], sub === "allow-code");
      case "remove":
      case "uninstall": return remove(stateDir, rest[0]);
      default:
        console.error(`unknown subcommand: plugin ${sub}\n\n${HELP}`);
        return 2;
    }
  } finally {
    resetPluginCache();
  }
}

function list(stateDir: string): number {
  const plugins = Object.values(readPluginState(stateDir).plugins).sort((a, b) => a.name.localeCompare(b.name));
  if (plugins.length === 0) {
    console.log("No plugins installed. Install one with: atomic-agent plugin install <folder>");
    return 0;
  }
  for (const rec of plugins) {
    const bundle = tryBundle(stateDir, rec.name);
    const parts = bundle ? summary(bundle) : "files missing or unreadable";
    console.log(`${rec.enabled ? "on " : "off"}  ${rec.name}@${rec.version}  ${parts}`);
  }
  return 0;
}

function show(stateDir: string, name: string | undefined): number {
  if (!name) { console.error("usage: atomic-agent plugin show <name>"); return 2; }
  const rec = readPluginState(stateDir).plugins[name];
  if (!rec) { console.error(`plugin not installed: ${name}`); return 1; }
  const bundle = tryBundle(stateDir, name);
  console.log(`${name}@${rec.version} (${rec.enabled ? "enabled" : "disabled"}), source: ${describeSource(rec.source)}`);
  if (!bundle) { console.log("Plugin files are missing or unreadable; reinstall it."); return 1; }
  if (bundle.manifest.description) console.log(bundle.manifest.description);
  console.log(`format: ${bundle.format}`);
  if (bundleRunsCode(bundle)) console.log(`runs code: ${pluginCodeParts(bundle).join("; ")} — ${rec.runsCodeAccepted ? "allowed" : "off until you run: atomic-agent plugin allow-code " + name}`);
  const section = (title: string, items: string[]) => { if (items.length) console.log(`\n${title}:\n${items.map(i => `  ${i}`).join("\n")}`); };
  section("Skills", bundle.skills.map(s => (s.name ? `${name}:${s.name}` : name) + (s.hasScripts ? " (has scripts)" : "")));
  section("Commands", bundle.commands.map(c => `/${name}:${c.name}`));
  section("MCP servers", Object.keys(bundle.mcpServers));
  section("Subagents", bundle.agents.map(a => a.name));
  if (bundle.hooksFile || bundle.manifest.hooksInline) section("Hooks", ["hooks.json"]);
  section("Notes", bundle.notes);
  return 0;
}

function install(stateDir: string, args: string[]): number {
  const force = args.includes("--force");
  const acceptCode = args.includes("--accept-code");
  const path = args.find(a => !a.startsWith("--"));
  if (!path) { console.error("usage: atomic-agent plugin install <path> [--force]"); return 2; }
  try {
    const rec = installPluginFromDir(stateDir, path, { force, acceptCode });
    const bundle = tryBundle(stateDir, rec.name);
    console.log(`Installed ${rec.name}@${rec.version}${bundle ? `: ${summary(bundle)}` : ""}`);
    if (bundle && bundleRunsCode(bundle) && !rec.runsCodeAccepted) {
      console.log(`  This plugin can run programs on this computer or receive your keys (${pluginCodeParts(bundle).join(", ")}).`);
      console.log(`  Those parts are off. Read them first, then: atomic-agent plugin allow-code ${rec.name}`);
    }
    for (const note of bundle?.notes ?? []) console.log(`  note: ${note}`);
    return 0;
  } catch (err) {
    if (err instanceof PluginInstallError || err instanceof PluginManifestError) { console.error(err.message); return 1; }
    throw err;
  }
}

/** `skill:<name>`, `mcp:<name>`, `hook:<Event>`, `command:<name>`, `agent:<name>`. */
const PART_ID_RE = /^(skill|mcp|hook|command|agent):\S+$/;

function toggle(stateDir: string, args: string[], enabled: boolean): number {
  const verb = enabled ? "enable" : "disable";
  const usage = `usage: atomic-agent plugin ${verb} <name> [--part skill:<name>|mcp:<name>|hook:<Event>|command:<name>|agent:<name>]`;
  let name: string | undefined;
  let part: string | undefined;
  let partFlag = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--part") { partFlag = true; part = args[++i]; continue; }
    if (a.startsWith("--part=")) { partFlag = true; part = a.slice("--part=".length); continue; }
    // Any other flag is a typo: never fall back to switching the whole plugin.
    if (a.startsWith("-")) { console.error(`unknown option: ${a}\n${usage}`); return 2; }
    if (name !== undefined) { console.error(usage); return 2; }
    name = a;
  }
  if (!name || (partFlag && !PART_ID_RE.test(part ?? ""))) { console.error(usage); return 2; }
  if (part) {
    const rec = readPluginState(stateDir).plugins[name];
    if (!rec) { console.error(`plugin not installed: ${name}`); return 1; }
    const known = loadPluginOverview(stateDir, rec, process.env).parts.map(p => p.id);
    if (!known.includes(part)) {
      console.error(`${name} has no part ${part}. Parts: ${known.length ? known.join(", ") : "none"}`);
      return 1;
    }
    if (!setPluginPartEnabled(stateDir, name, part, enabled)) { console.error(`plugin not installed: ${name}`); return 1; }
    console.log(`${name} ${part} ${enabled ? "on" : "off"}. Restart running agents to pick up MCP server changes.`);
    return 0;
  }
  if (!setPluginEnabled(stateDir, name, enabled)) { console.error(`plugin not installed: ${name}`); return 1; }
  console.log(`${name} ${enabled ? "enabled" : "disabled"}. Restart running agents to pick up its MCP servers.`);
  return 0;
}

function code(stateDir: string, name: string | undefined, allow: boolean): number {
  if (!name) { console.error(`usage: atomic-agent plugin ${allow ? "allow-code" : "deny-code"} <name>`); return 2; }
  if (!setPluginCodeAllowed(stateDir, name, allow)) { console.error(`plugin not installed: ${name}`); return 1; }
  console.log(allow
    ? `${name} may now run its local MCP servers, hooks and scripts and receive your keys. Restart running agents to start its servers.`
    : `${name}'s local MCP servers, hooks, scripts and servers that read your keys are off.`);
  return 0;
}

/** Plain list of what would run, for the consent line. Lives in plugin-overview.ts so both UIs share it. */
export const codeParts: (b: PluginBundle) => string[] = pluginCodeParts;

/** `plugin list --json`: `{ "plugins": PluginOverview[] }`, for the desktop app and scripts. */
function listJson(stateDir: string): number {
  console.log(JSON.stringify({ plugins: loadPluginOverviews(stateDir, process.env) }));
  return 0;
}

/** `plugin show <name> --json`: one PluginOverview, or a JSON error with exit 1. */
function showJson(stateDir: string, name: string | undefined): number {
  if (!name) { console.error("usage: atomic-agent plugin show <name> --json"); return 2; }
  const rec = readPluginState(stateDir).plugins[name];
  if (!rec) { console.log(JSON.stringify({ error: `plugin not installed: ${name}` })); return 1; }
  console.log(JSON.stringify({ plugin: loadPluginOverview(stateDir, rec, process.env) }));
  return 0;
}

function remove(stateDir: string, name: string | undefined): number {
  if (!name) { console.error("usage: atomic-agent plugin remove <name>"); return 2; }
  if (!removePlugin(stateDir, name)) { console.error(`plugin not installed: ${name}`); return 1; }
  console.log(`Removed ${name}.`);
  return 0;
}

function tryBundle(stateDir: string, name: string): PluginBundle | null {
  try { return readPluginBundle(installedPluginDir(stateDir, name)); } catch { return null; }
}

export function summary(b: PluginBundle): string {
  const parts = [
    [b.skills.length, "skill"],
    [b.commands.length, "command"],
    [Object.keys(b.mcpServers).length, "MCP server"],
    [b.agents.length, "subagent"],
  ] as const;
  const text = parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`);
  if (b.hooksFile || b.manifest.hooksInline) text.push("hooks");
  return text.length ? text.join(", ") : "empty";
}

function describeSource(source: { kind: string; [k: string]: unknown }): string {
  if (source.kind === "local") return `folder ${String(source.path)}`;
  if (source.kind === "marketplace") return `marketplace ${String(source.marketplace)}`;
  return `${source.kind} ${String(source.url ?? "")}`;
}
