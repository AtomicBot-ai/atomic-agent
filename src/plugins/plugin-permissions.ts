import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { bundleRunsCode } from "./plugin-bundle.js";
import type { PluginBundle } from "./plugin-types.js";

/**
 * What a plugin would run on this computer, and how that changes between
 * two versions. The snapshot is read from disk once (hooks.json, script
 * hashes); everything after that is pure, so the CLI and the desktop show
 * the same list and the same diff.
 */

export interface PluginHookCommand {
  event: string;
  matcher?: string;
  command: string;
}

export interface PluginMcpPermission {
  name: string;
  /** `local` starts a program (stdio); `remote` only connects to a URL. */
  transport: "local" | "remote";
  /** Program and arguments, joined, for a local server. */
  command?: string;
  url?: string;
}

export interface PluginScriptFile {
  /** Path inside the plugin, POSIX separators. */
  path: string;
  /** sha256 of the file, so a changed script shows up in the diff. */
  sha256: string;
}

export interface PluginPermissionSnapshot {
  name: string;
  version: string;
  runsCode: boolean;
  hooks: PluginHookCommand[];
  mcpServers: PluginMcpPermission[];
  scripts: PluginScriptFile[];
  skills: string[];
  commands: string[];
  agents: string[];
}

const SCRIPT_EXT = new Set([".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl", ".ps1", ".bat", ".cmd"]);
const MAX_SCRIPTS = 500;
const MAX_HOOKS_BYTES = 512 * 1024;

/** Read everything that can run from a parsed bundle. Never runs anything. */
export function pluginPermissionSnapshot(bundle: PluginBundle): PluginPermissionSnapshot {
  return {
    name: bundle.name,
    version: bundle.manifest.version,
    runsCode: bundleRunsCode(bundle),
    hooks: readHooks(bundle),
    mcpServers: Object.entries(bundle.mcpServers)
      .map(([name, raw]) => mcpPermission(name, raw))
      .sort((a, b) => a.name.localeCompare(b.name)),
    scripts: readScripts(bundle),
    skills: bundle.skills.map(s => s.name || bundle.name).sort(),
    commands: bundle.commands.map(c => c.name).sort(),
    agents: bundle.agents.map(a => a.name).sort(),
  };
}

function mcpPermission(name: string, raw: Record<string, unknown>): PluginMcpPermission {
  if (typeof raw.command === "string") {
    const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [];
    return { name, transport: "local", command: [raw.command, ...args].join(" ") };
  }
  return { name, transport: "remote", ...(typeof raw.url === "string" ? { url: raw.url } : {}) };
}

/** Commands from hooks.json and inline manifest hooks: `{hooks: {Event: [{matcher, hooks: [{type, command}]}]}}` or the bare event map. */
function readHooks(bundle: PluginBundle): PluginHookCommand[] {
  const out: PluginHookCommand[] = [];
  const add = (raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const obj = raw as Record<string, unknown>;
    const events = obj.hooks && typeof obj.hooks === "object" && !Array.isArray(obj.hooks) ? obj.hooks as Record<string, unknown> : obj;
    for (const [event, groups] of Object.entries(events)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!group || typeof group !== "object") continue;
        const g = group as Record<string, unknown>;
        const matcher = typeof g.matcher === "string" ? g.matcher : undefined;
        const list = Array.isArray(g.hooks) ? g.hooks : [g];
        for (const h of list) {
          if (!h || typeof h !== "object") continue;
          const cmd = (h as Record<string, unknown>).command;
          if (typeof cmd === "string") out.push({ event, ...(matcher ? { matcher } : {}), command: cmd });
          else out.push({ event, ...(matcher ? { matcher } : {}), command: `(${String((h as Record<string, unknown>).type ?? "unknown")} hook)` });
        }
      }
    }
  };
  if (bundle.hooksFile) {
    try {
      if (statSync(bundle.hooksFile).size <= MAX_HOOKS_BYTES) add(JSON.parse(readFileSync(bundle.hooksFile, "utf8")));
      else out.push({ event: "*", command: "(hooks.json too large to read; treat as unknown code)" });
    } catch {
      out.push({ event: "*", command: "(hooks.json could not be read; treat as unknown code)" });
    }
  }
  if (bundle.manifest.hooksInline) add(bundle.manifest.hooksInline);
  return out.sort((a, b) => `${a.event}\0${a.matcher ?? ""}\0${a.command}`.localeCompare(`${b.event}\0${b.matcher ?? ""}\0${b.command}`));
}

/** Script files in skill folders (anything under scripts/ or bin/, or a script extension) and script files under hooks/. */
function readScripts(bundle: PluginBundle): PluginScriptFile[] {
  const out: PluginScriptFile[] = [];
  const seen = new Set<string>();
  const visit = (dir: string, underScripts: boolean, depth: number) => {
    if (depth > 6 || out.length >= MAX_SCRIPTS) return;
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const n of names) {
      if (n === ".git" || n === "node_modules") continue;
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { visit(p, underScripts || n === "scripts" || n === "bin", depth + 1); continue; }
      if (!st.isFile() || (!underScripts && !SCRIPT_EXT.has(extname(n).toLowerCase()))) continue;
      const rel = relative(bundle.root, p).split(sep).join("/");
      if (seen.has(rel)) continue;
      seen.add(rel);
      let sha256 = "unreadable";
      try { sha256 = createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { /* keep marker */ }
      out.push({ path: rel, sha256 });
    }
  };
  for (const s of bundle.skills) if (s.hasScripts) visit(s.dir, false, 0);
  // Scripts a hook may call; hooks.json itself is read as hooks, not listed here.
  visit(join(bundle.root, "hooks"), false, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export interface PluginPermissionDiff {
  /** True when this is a first install (nothing to compare with). */
  fresh: boolean;
  mcpAdded: PluginMcpPermission[];
  mcpRemoved: PluginMcpPermission[];
  mcpChanged: Array<{ before: PluginMcpPermission; after: PluginMcpPermission }>;
  hooksAdded: PluginHookCommand[];
  hooksRemoved: PluginHookCommand[];
  scriptsAdded: string[];
  scriptsChanged: string[];
  scriptsRemoved: string[];
  skillsAdded: string[];
  commandsAdded: string[];
  agentsAdded: string[];
  /** runsCode was false and is now true. */
  startsRunningCode: boolean;
  /**
   * Anything that can run changed (new or changed local MCP server, new or
   * changed hook, new or changed script; or the plugin starts running
   * code). When true an earlier "yes, it may run code" no longer covers it.
   * Remote MCP URL changes are shown but do not reset consent: they run nothing here.
   */
  codeChanged: boolean;
}

/** Old vs new, from two parsed bundles. `oldBundle` null means first install. */
export function diffPluginPermissions(oldBundle: PluginBundle | null, newBundle: PluginBundle): PluginPermissionDiff {
  return diffPermissionSnapshots(oldBundle ? pluginPermissionSnapshot(oldBundle) : null, pluginPermissionSnapshot(newBundle));
}

/** Pure diff of two snapshots. */
export function diffPermissionSnapshots(before: PluginPermissionSnapshot | null, after: PluginPermissionSnapshot): PluginPermissionDiff {
  const old = before ?? { name: after.name, version: "", runsCode: false, hooks: [], mcpServers: [], scripts: [], skills: [], commands: [], agents: [] };
  const oldMcp = new Map(old.mcpServers.map(m => [m.name, m]));
  const newMcp = new Map(after.mcpServers.map(m => [m.name, m]));
  const mcpAdded = after.mcpServers.filter(m => !oldMcp.has(m.name));
  const mcpRemoved = old.mcpServers.filter(m => !newMcp.has(m.name));
  const mcpChanged = after.mcpServers
    .filter(m => oldMcp.has(m.name) && !sameMcp(oldMcp.get(m.name)!, m))
    .map(m => ({ before: oldMcp.get(m.name)!, after: m }));
  const hookKey = (h: PluginHookCommand) => `${h.event}\0${h.matcher ?? ""}\0${h.command}`;
  const oldHooks = new Set(old.hooks.map(hookKey));
  const newHooks = new Set(after.hooks.map(hookKey));
  const hooksAdded = after.hooks.filter(h => !oldHooks.has(hookKey(h)));
  const hooksRemoved = old.hooks.filter(h => !newHooks.has(hookKey(h)));
  const oldScripts = new Map(old.scripts.map(s => [s.path, s.sha256]));
  const newScripts = new Set(after.scripts.map(s => s.path));
  const scriptsAdded = after.scripts.filter(s => !oldScripts.has(s.path)).map(s => s.path);
  const scriptsChanged = after.scripts.filter(s => oldScripts.has(s.path) && oldScripts.get(s.path) !== s.sha256).map(s => s.path);
  const scriptsRemoved = old.scripts.filter(s => !newScripts.has(s.path)).map(s => s.path);
  const added = (a: string[], b: string[]) => { const set = new Set(a); return b.filter(x => !set.has(x)); };
  const startsRunningCode = !old.runsCode && after.runsCode;
  const codeMcp = (m: PluginMcpPermission) => m.transport === "local";
  const codeChanged =
    startsRunningCode ||
    mcpAdded.some(codeMcp) ||
    mcpChanged.some(c => codeMcp(c.after) || codeMcp(c.before)) ||
    hooksAdded.length > 0 ||
    scriptsAdded.length > 0 ||
    scriptsChanged.length > 0;
  return {
    fresh: before === null,
    mcpAdded,
    mcpRemoved,
    mcpChanged,
    hooksAdded,
    hooksRemoved,
    scriptsAdded,
    scriptsChanged,
    scriptsRemoved,
    skillsAdded: added(old.skills, after.skills),
    commandsAdded: added(old.commands, after.commands),
    agentsAdded: added(old.agents, after.agents),
    startsRunningCode,
    codeChanged,
  };
}

function sameMcp(a: PluginMcpPermission, b: PluginMcpPermission): boolean {
  return a.transport === b.transport && a.command === b.command && a.url === b.url;
}

/** One line per thing that would run, in plain words. */
export function describePluginCode(snapshot: PluginPermissionSnapshot): string[] {
  const lines: string[] = [];
  for (const m of snapshot.mcpServers) if (m.transport === "local") lines.push(`local MCP server ${m.name}: ${m.command}`);
  for (const h of snapshot.hooks) lines.push(`hook on ${h.event}${h.matcher ? ` (${h.matcher})` : ""}: ${h.command}`);
  for (const s of snapshot.scripts) lines.push(`script file ${s.path}`);
  return lines;
}

/** The diff in plain words; empty when nothing a person would care about changed. */
export function describePermissionDiff(diff: PluginPermissionDiff): string[] {
  if (diff.fresh) return [];
  const lines: string[] = [];
  if (diff.startsRunningCode) lines.push("This version can run programs on your computer; the previous one could not.");
  for (const m of diff.mcpAdded) lines.push(m.transport === "local" ? `New local MCP server ${m.name} runs: ${m.command}` : `New remote MCP server ${m.name}${m.url ? ` at ${m.url}` : ""}`);
  for (const c of diff.mcpChanged) {
    lines.push(c.after.transport === "local"
      ? `MCP server ${c.after.name} now runs: ${c.after.command}${c.before.command ? ` (was: ${c.before.command})` : ""}`
      : `MCP server ${c.after.name} now connects to ${c.after.url ?? "another address"}${c.before.url ? ` (was ${c.before.url})` : ""}`);
  }
  for (const m of diff.mcpRemoved) lines.push(`MCP server ${m.name} was removed`);
  for (const h of diff.hooksAdded) lines.push(`New or changed hook on ${h.event}${h.matcher ? ` (${h.matcher})` : ""}: ${h.command}`);
  if (diff.hooksRemoved.length) lines.push(`${diff.hooksRemoved.length} hook(s) removed`);
  for (const s of diff.scriptsAdded) lines.push(`New script file ${s}`);
  for (const s of diff.scriptsChanged) lines.push(`Changed script file ${s}`);
  if (diff.scriptsRemoved.length) lines.push(`${diff.scriptsRemoved.length} script file(s) removed`);
  if (diff.skillsAdded.length) lines.push(`New skills: ${diff.skillsAdded.join(", ")}`);
  if (diff.commandsAdded.length) lines.push(`New commands: ${diff.commandsAdded.join(", ")}`);
  if (diff.agentsAdded.length) lines.push(`New subagents: ${diff.agentsAdded.join(", ")}`);
  return lines;
}

/**
 * Stable id of exactly what would run. A desktop "allow" answer echoes it,
 * so a plugin whose code changed after the question was shown is never
 * allowed unseen (same idea as the project-trust question id).
 */
export function codeConsentIdOf(snapshot: PluginPermissionSnapshot): string {
  const canonical = JSON.stringify({
    mcp: snapshot.mcpServers.filter(m => m.transport === "local").map(m => [m.name, m.command]),
    hooks: snapshot.hooks.map(h => [h.event, h.matcher ?? "", h.command]),
    scripts: snapshot.scripts.map(s => [s.path, s.sha256]),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
