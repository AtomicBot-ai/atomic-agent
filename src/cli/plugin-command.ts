import { getConfig } from "../config/index.js";
import {
  bundleRunsCode,
  installPluginFromDir,
  installedPluginDir,
  PluginInstallError,
  PluginManifestError,
  readPluginBundle,
  readPluginState,
  removePlugin,
  resetPluginCache,
  setPluginEnabled,
  type PluginBundle,
} from "../plugins/index.js";

const HELP = [
  "atomic-agent plugin — manage plugins (Claude / Codex / Cursor plugin packages)",
  "",
  "Subcommands:",
  "  list                       List installed plugins with what each one brings",
  "  show <name>                Print a plugin's skills, commands, MCP servers, hooks and notes",
  "  install <path> [--force]   Install a plugin from a local folder (copied into the data folder)",
  "  enable <name>              Switch an installed plugin on",
  "  disable <name>             Switch a plugin off without removing it",
  "  remove <name>              Uninstall a plugin and delete its files",
  "",
  "Plugins live in <data folder>/plugins and are shared with the desktop app.",
  "Skills appear as plugin:skill. MCP servers start on the next agent start.",
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
      case "list": return list(stateDir);
      case "show": return show(stateDir, rest[0]);
      case "install": return install(stateDir, rest);
      case "enable":
      case "disable": return toggle(stateDir, rest[0], sub === "enable");
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
  console.log(`format: ${bundle.format}${bundleRunsCode(bundle) ? " · runs code on this computer" : ""}`);
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
  const path = args.find(a => !a.startsWith("--"));
  if (!path) { console.error("usage: atomic-agent plugin install <path> [--force]"); return 2; }
  try {
    const rec = installPluginFromDir(stateDir, path, { force });
    const bundle = tryBundle(stateDir, rec.name);
    console.log(`Installed ${rec.name}@${rec.version}${bundle ? `: ${summary(bundle)}` : ""}`);
    for (const note of bundle?.notes ?? []) console.log(`  note: ${note}`);
    return 0;
  } catch (err) {
    if (err instanceof PluginInstallError || err instanceof PluginManifestError) { console.error(err.message); return 1; }
    throw err;
  }
}

function toggle(stateDir: string, name: string | undefined, enabled: boolean): number {
  if (!name) { console.error(`usage: atomic-agent plugin ${enabled ? "enable" : "disable"} <name>`); return 2; }
  if (!setPluginEnabled(stateDir, name, enabled)) { console.error(`plugin not installed: ${name}`); return 1; }
  console.log(`${name} ${enabled ? "enabled" : "disabled"}. Restart running agents to pick up its MCP servers.`);
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
