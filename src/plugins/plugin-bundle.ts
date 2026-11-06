import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { readPluginManifest, PluginManifestError } from "./plugin-manifest.js";
import type { PluginAgentEntry, PluginBundle, PluginCommandEntry, PluginSkillEntry } from "./plugin-types.js";

const SCRIPT_EXT = new Set([".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl", ".ps1", ".bat", ".cmd"]);
const MAX_ENTRIES = 2048;
const MAX_JSON_BYTES = 512 * 1024;

/**
 * Read everything a plugin ships, without running any of it. Unknown or
 * unsupported parts become plain-language `notes` instead of errors, so a
 * Claude plugin that also has output styles still installs its skills.
 */
export function readPluginBundle(root: string): PluginBundle {
  const absRoot = resolve(root);
  const { format, manifest } = readPluginManifest(absRoot);
  const notes: string[] = [];

  const skillDirs = manifest.skillPaths.length ? manifest.skillPaths : [join(absRoot, "skills")];
  const skills = readSkills(absRoot, skillDirs);
  const commandDirs = manifest.commandPaths.length ? manifest.commandPaths : [join(absRoot, "commands")];
  const commands = readMarkdownTree(commandDirs).map<PluginCommandEntry>(e => ({ name: e.name, file: e.file }));
  const agentDirs = manifest.agentPaths.length ? manifest.agentPaths : [join(absRoot, "agents")];
  const agents = readMarkdownTree(agentDirs).map<PluginAgentEntry>(e => ({ name: e.name, file: e.file }));

  let hooksFile: string | undefined;
  const hooksCandidate = manifest.hooksPath ?? join(absRoot, "hooks", "hooks.json");
  if (isFile(hooksCandidate)) hooksFile = hooksCandidate;
  if (manifest.hooksInline) notes.push("Inline hooks in plugin.json are read by the hooks loader, not stored as a file.");

  const mcpServers: Record<string, Record<string, unknown>> = {};
  const mcpFile = manifest.mcpPath ?? join(absRoot, ".mcp.json");
  if (isFile(mcpFile)) Object.assign(mcpServers, readMcpFile(mcpFile));
  if (manifest.mcpInline) Object.assign(mcpServers, mcpMap(manifest.mcpInline));

  for (const key of manifest.unsupportedKeys) notes.push(`Skipped "${key}": not supported yet.`);
  if (agents.length) notes.push(`${agents.length} subagent profile(s) found; they are listed but only used once subagent profiles land.`);
  if (format !== "claude" && format !== "conventional") notes.push(`Read as a ${format} package; only skills, commands, agents, hooks and MCP servers are used.`);

  return { name: manifest.name, root: absRoot, format, manifest, skills, commands, agents, hooksFile, mcpServers, notes };
}

/** True when enabling the plugin can make the computer run something: hooks, stdio MCP servers or skill scripts. */
export function bundleRunsCode(bundle: PluginBundle): boolean {
  if (bundle.hooksFile || bundle.manifest.hooksInline) return true;
  if (bundle.skills.some(s => s.hasScripts)) return true;
  return Object.values(bundle.mcpServers).some(s => typeof s.command === "string");
}

function readSkills(root: string, dirs: string[]): PluginSkillEntry[] {
  const out: PluginSkillEntry[] = [];
  const seen = new Set<string>();
  // A plugin may itself be a single skill: SKILL.md at its root.
  if (isFile(join(root, "SKILL.md"))) {
    out.push({ name: "", dir: root, hasScripts: hasScripts(root) });
    seen.add(root);
  }
  for (const dir of dirs) {
    if (isFile(join(dir, "SKILL.md")) && !seen.has(dir)) {
      out.push({ name: lastSegment(dir), dir, hasScripts: hasScripts(dir) });
      seen.add(dir);
      continue;
    }
    for (const name of safeList(dir)) {
      const skillDir = join(dir, name);
      if (seen.has(skillDir) || !isFile(join(skillDir, "SKILL.md"))) continue;
      seen.add(skillDir);
      out.push({ name, dir: skillDir, hasScripts: hasScripts(skillDir) });
      if (out.length >= MAX_ENTRIES) break;
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Markdown files under the given folders; nested folders become `a:b` names like Claude does. */
function readMarkdownTree(dirs: string[]): Array<{ name: string; file: string }> {
  const out: Array<{ name: string; file: string }> = [];
  for (const dir of dirs) {
    if (isFile(dir) && dir.endsWith(".md")) { out.push({ name: lastSegment(dir).replace(/\.md$/, ""), file: dir }); continue; }
    const walk = (current: string, depth: number) => {
      if (depth > 4 || out.length >= MAX_ENTRIES) return;
      for (const entry of safeList(current)) {
        const p = join(current, entry);
        if (isDir(p)) walk(p, depth + 1);
        else if (entry.endsWith(".md") && entry.toLowerCase() !== "readme.md") {
          const name = relative(dir, p).replace(/\.md$/, "").split(sep).join(":");
          out.push({ name, file: p });
        }
      }
    };
    walk(dir, 0);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function readMcpFile(file: string): Record<string, Record<string, unknown>> {
  if (statSync(file).size > MAX_JSON_BYTES) throw new PluginManifestError(`${file} is larger than 512 KiB`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); }
  catch (err) { throw new PluginManifestError(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  // Both `{ "mcpServers": { ... } }` and a bare `{ "<name>": { ... } }` map are in use.
  const envelope = obj.mcpServers && typeof obj.mcpServers === "object" ? obj.mcpServers as Record<string, unknown> : obj;
  return mcpMap(envelope);
}

function mcpMap(obj: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) out[k] = v as Record<string, unknown>;
  }
  return out;
}

function hasScripts(dir: string): boolean {
  if (isDir(join(dir, "scripts"))) return true;
  return safeList(dir).some(f => SCRIPT_EXT.has(extname(f).toLowerCase()));
}

function lastSegment(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir).filter(n => !n.startsWith(".")).sort(); } catch { return []; }
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
