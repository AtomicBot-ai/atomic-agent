import { getConfig } from "../config/index.js";
import {
  addMarketplace,
  bundleRunsCode,
  describeMarketplaceSource,
  installMarketplacePlugin,
  installPluginFromDir,
  listMarketplaces,
  loadMarketplace,
  looksLikePluginSpec,
  MarketplaceError,
  removeMarketplace,
  updateMarketplaces,
  updatePlugin,
  installedPluginDir,
  PluginInstallError,
  PluginManifestError,
  readPluginBundle,
  readPluginState,
  removePlugin,
  resetPluginCache,
  setPluginEnabled,
  updatePluginRecord,
  type InstalledPluginRecord,
  type PluginBundle,
  type PluginReview,
} from "../plugins/index.js";

const HELP = [
  "atomic-agent plugin — manage plugins (Claude / Codex / Cursor plugin packages)",
  "",
  "Subcommands:",
  "  list                       List installed plugins with what each one brings",
  "  show <name>                Print a plugin's skills, commands, MCP servers, hooks and notes",
  "  install <path> [--force] [--accept-code]",
  "                             Install a plugin from a local folder (copied into the data folder).",
  "                             Parts that run programs (local MCP servers, hooks, scripts) stay off",
  "                             until you allow them: --accept-code here, or allow-code later",
  "  install <name>[@market] [--force] [--accept-code]",
  "                             Install a plugin listed in an added marketplace",
  "  update <name> [--force]    Reinstall a plugin from its marketplace or folder if it changed",
  "  allow-code <name>          Let a plugin's local MCP servers, hooks and scripts run",
  "  deny-code <name>           Switch those parts off again (skills and remote servers keep working)",
  "  enable <name>              Switch an installed plugin on",
  "  disable <name>             Switch a plugin off without removing it",
  "  remove <name>              Uninstall a plugin and delete its files",
  "",
  "  marketplace add <owner/repo | git URL | folder | URL to marketplace.json> [--ref <branch|tag>]",
  "  marketplace list           Added marketplaces, where they come from and the pinned commit",
  "  marketplace show <name>    Plugins a marketplace lists",
  "  marketplace update [name]  Fetch the latest marketplace listing (all when no name)",
  "  marketplace remove <name>  Forget a marketplace (its installed plugins stay installed)",
  "",
  "Installing never runs plugin code; git hooks are off while fetching.",
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
      case "install": return await install(stateDir, rest);
      case "update":
      case "upgrade": return await update(stateDir, rest);
      case "marketplace":
      case "marketplaces": return await marketplace(stateDir, rest);
      case "enable":
      case "disable": return toggle(stateDir, rest[0], sub === "enable");
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
    console.log("No plugins installed. Install one with: atomic-agent plugin install <folder | name@marketplace>");
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
  if (bundleRunsCode(bundle)) console.log(`runs code: ${codeParts(bundle).join("; ")} — ${rec.runsCodeAccepted ? "allowed" : "off until you run: atomic-agent plugin allow-code " + name}`);
  const section = (title: string, items: string[]) => { if (items.length) console.log(`\n${title}:\n${items.map(i => `  ${i}`).join("\n")}`); };
  section("Skills", bundle.skills.map(s => (s.name ? `${name}:${s.name}` : name) + (s.hasScripts ? " (has scripts)" : "")));
  section("Commands", bundle.commands.map(c => `/${name}:${c.name}`));
  section("MCP servers", Object.keys(bundle.mcpServers));
  section("Subagents", bundle.agents.map(a => a.name));
  if (bundle.hooksFile || bundle.manifest.hooksInline) section("Hooks", ["hooks.json"]);
  section("Notes", bundle.notes);
  return 0;
}

async function install(stateDir: string, args: string[]): Promise<number> {
  const force = args.includes("--force");
  const acceptCode = args.includes("--accept-code");
  const path = args.find(a => !a.startsWith("--"));
  if (!path) { console.error("usage: atomic-agent plugin install <path | name[@marketplace]> [--force] [--accept-code]"); return 2; }
  if (looksLikePluginSpec(path)) {
    try {
      const res = await installMarketplacePlugin(stateDir, path, { force, ...(acceptCode ? { review: acceptAllCode } : {}) });
      const bundle = tryBundle(stateDir, res.record.name);
      console.log(`Installed ${res.record.name}@${res.record.version} from ${res.marketplace}${bundle ? `: ${summary(bundle)}` : ""}`);
      printCodeHint(res.record, bundle);
      for (const note of res.notes) console.log(`  note: ${note}`);
      return 0;
    } catch (err) {
      return reportError(err);
    }
  }
  try {
    const rec = installPluginFromDir(stateDir, path, { force, acceptCode });
    const bundle = tryBundle(stateDir, rec.name);
    console.log(`Installed ${rec.name}@${rec.version}${bundle ? `: ${summary(bundle)}` : ""}`);
    printCodeHint(rec, bundle);
    for (const note of bundle?.notes ?? []) console.log(`  note: ${note}`);
    return 0;
  } catch (err) {
    if (err instanceof PluginInstallError || err instanceof PluginManifestError) { console.error(err.message); return 1; }
    throw err;
  }
}

async function update(stateDir: string, args: string[]): Promise<number> {
  const name = args.find(a => !a.startsWith("--"));
  if (!name) { console.error("usage: atomic-agent plugin update <name> [--force] [--accept-code]"); return 2; }
  try {
    const res = await updatePlugin(stateDir, name, { force: args.includes("--force"), ...(args.includes("--accept-code") ? { review: acceptAllCode } : {}) });
    if (res.status === "up-to-date") { console.log(`${name}@${res.record.version} is up to date.`); return 0; }
    console.log(`Updated ${name}: ${res.previous.version} -> ${res.record.version}${res.record.enabled ? "" : " (disabled)"}`);
    printCodeHint(res.record, tryBundle(stateDir, name));
    for (const note of res.notes) console.log(`  note: ${note}`);
    return 0;
  } catch (err) {
    return reportError(err);
  }
}

async function marketplace(stateDir: string, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const positional = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--ref");
  try {
    switch (sub) {
      case "add": {
        const input = positional[0];
        if (!input) { console.error("usage: atomic-agent plugin marketplace add <owner/repo | git URL | folder | URL> [--ref <ref>]"); return 2; }
        const refIdx = rest.indexOf("--ref");
        const ref = refIdx >= 0 ? rest[refIdx + 1] : undefined;
        if (refIdx >= 0 && !ref) { console.error("--ref needs a branch or tag"); return 2; }
        const { record, manifest } = await addMarketplace(stateDir, input, ref ? { ref } : {});
        console.log(`Added marketplace ${record.name} (${manifest.plugins.length} plugin${manifest.plugins.length === 1 ? "" : "s"})${record.sha ? ` at ${record.sha.slice(0, 12)}` : ""}.`);
        for (const p of manifest.problems) console.log(`  note: ${p}`);
        console.log(`Install one with: atomic-agent plugin install <name>@${record.name}`);
        return 0;
      }
      case "list":
      case undefined: {
        const all = listMarketplaces(stateDir);
        if (all.length === 0) { console.log("No marketplaces added. Add one with: atomic-agent plugin marketplace add <owner/repo>"); return 0; }
        for (const m of all) {
          const count = m.manifest ? `${m.manifest.plugins.length} plugins` : `unreadable: ${m.error}`;
          const pin = m.record.sha ? ` @ ${m.record.sha.slice(0, 12)}` : "";
          console.log(`${m.record.name}  ${describeMarketplaceSource(m.record.source)}${m.record.ref ? `#${m.record.ref}` : ""}${pin}  ${count}  fetched ${m.record.fetchedAt}`);
        }
        return 0;
      }
      case "show":
      case "browse": {
        const name = positional[0];
        if (!name) { console.error("usage: atomic-agent plugin marketplace show <name>"); return 2; }
        const m = loadMarketplace(stateDir, name);
        if (!m.manifest) { console.error(`marketplace ${name} cannot be read: ${m.error}`); return 1; }
        const installed = readPluginState(stateDir).plugins;
        for (const p of m.manifest.plugins) {
          const mark = installed[p.name] ? "installed " : "          ";
          const blocked = p.source.kind === "unsupported" ? `  (cannot install: ${p.source.reason})` : "";
          console.log(`${mark}${p.name}${p.version ? `@${p.version}` : ""}  ${p.description.slice(0, 100)}${blocked}`);
        }
        for (const p of m.manifest.problems) console.log(`note: ${p}`);
        return 0;
      }
      case "update":
      case "refresh": {
        const results = await updateMarketplaces(stateDir, positional[0]);
        if (results.length === 0) { console.log("No marketplaces added."); return 0; }
        let failed = 0;
        for (const r of results) {
          if (r.error) { failed++; console.error(`${r.name}: ${r.error}`); continue; }
          console.log(`${r.name}: ${r.changed ? `updated${r.sha ? ` to ${r.sha.slice(0, 12)}` : ""}` : "already up to date"}`);
        }
        if (results.some(r => r.changed)) console.log("Run `atomic-agent plugin update <name>` to update installed plugins.");
        return failed ? 1 : 0;
      }
      case "remove":
      case "rm": {
        const name = positional[0];
        if (!name) { console.error("usage: atomic-agent plugin marketplace remove <name>"); return 2; }
        const res = removeMarketplace(stateDir, name);
        if (!res.removed) { console.error(`no marketplace named ${name}`); return 1; }
        console.log(`Removed marketplace ${name}.`);
        if (res.plugins.length) console.log(`Still installed from it: ${res.plugins.join(", ")}. Remove them with \`atomic-agent plugin remove <name>\` if you no longer want them.`);
        return 0;
      }
      default:
        console.error(`unknown subcommand: plugin marketplace ${sub}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    return reportError(err);
  }
}

function reportError(err: unknown): number {
  if (err instanceof PluginInstallError || err instanceof PluginManifestError || err instanceof MarketplaceError) { console.error(err.message); return 1; }
  throw err;
}

function toggle(stateDir: string, name: string | undefined, enabled: boolean): number {
  if (!name) { console.error(`usage: atomic-agent plugin ${enabled ? "enable" : "disable"} <name>`); return 2; }
  if (!setPluginEnabled(stateDir, name, enabled)) { console.error(`plugin not installed: ${name}`); return 1; }
  console.log(`${name} ${enabled ? "enabled" : "disabled"}. Restart running agents to pick up its MCP servers.`);
  return 0;
}

function code(stateDir: string, name: string | undefined, allow: boolean): number {
  if (!name) { console.error(`usage: atomic-agent plugin ${allow ? "allow-code" : "deny-code"} <name>`); return 2; }
  const rec = updatePluginRecord(stateDir, name, r => ({ ...r, runsCodeAccepted: allow }));
  if (!rec) { console.error(`plugin not installed: ${name}`); return 1; }
  console.log(allow
    ? `${name} may now run its local MCP servers, hooks and scripts. Restart running agents to start its servers.`
    : `${name}'s local MCP servers, hooks and scripts are off.`);
  return 0;
}

/** `--accept-code`: the person agreed up front, on the command line. */
const acceptAllCode: PluginReview = async () => ({ runsCodeAccepted: true });

function printCodeHint(rec: InstalledPluginRecord, bundle: PluginBundle | null): void {
  if (!bundle || !bundleRunsCode(bundle) || rec.runsCodeAccepted) return;
  console.log(`  This plugin can run programs on this computer (${codeParts(bundle).join(", ")}).`);
  console.log(`  Those parts are off. Read them first, then: atomic-agent plugin allow-code ${rec.name}`);
}

/** Plain list of what would run, for the consent line. */
export function codeParts(b: PluginBundle): string[] {
  const out: string[] = [];
  const stdio = Object.entries(b.mcpServers).filter(([, s]) => typeof s.command === "string").map(([n]) => n);
  if (stdio.length) out.push(`local MCP servers: ${stdio.join(", ")}`);
  if (b.hooksFile || b.manifest.hooksInline) out.push("hooks");
  const scripted = b.skills.filter(s => s.hasScripts).map(s => s.name || b.name);
  if (scripted.length) out.push(`skill scripts: ${scripted.join(", ")}`);
  return out;
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
  if (source.kind === "marketplace") {
    const sha = typeof source.sha === "string" ? ` at ${source.sha.slice(0, 12)}` : "";
    return `${String(source.entry)}@${String(source.marketplace)}${sha}`;
  }
  return `${source.kind} ${String(source.url ?? "")}`;
}
