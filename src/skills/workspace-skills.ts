import { createHash } from "node:crypto";
import { readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readUserConfigFileSync } from "../config/config-file.js";
import type { RuntimeSkillsConfig } from "../config/skills-config.js";
import type { SkillRecord } from "./skill-loader.js";
import { isSkillEligibleForPlatform } from "./skill-loader.js";
import { parseSkillFile } from "./skill-manifest.js";
import { readWorkspaceFile, isWithinWorkspace } from "./workspace-files.js";

export interface WorkspaceSkill {
  record: SkillRecord;
  body: string;
  fingerprint: string;
  disabledReasons: string[];
  sources: string[];
}
export interface WorkspaceSkills {
  workingDir: string;
  projectSkillsEnabled: boolean;
  entries: WorkspaceSkill[];
  diagnostics: string[];
  /** Read live policy and validate the chosen source, including after approval. */
  assertAvailable(name: string): WorkspaceSkill;
}
export interface WorkspaceSkillsOptions {
  globalDir: string;
  projectDirName: string;
  configFile: string;
  defaults: RuntimeSkillsConfig;
}

export function workspaceSkillBody(entry: WorkspaceSkill): string {
  return `Skill directory: ${entry.record.rootDir}\nResolve this skill's relative scripts/references against that directory.\n${entry.body}`;
}

/** Skill discovery problems never fail a step: they degrade to diagnostics. */
export function loadWorkspaceSkills(workingDir: string, options: WorkspaceSkillsOptions, compatibility = true): WorkspaceSkills {
  try { return loadSkills(workingDir, options, compatibility); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { workingDir: resolve(workingDir), projectSkillsEnabled: false, entries: [], diagnostics: [`Workspace skills unavailable: ${reason}`],
      assertAvailable(name) { throw new Error(`Skill ${name} unavailable: workspace skills could not be loaded (${reason})`); } };
  }
}

function loadSkills(workingDir: string, options: WorkspaceSkillsOptions, compatibility: boolean): WorkspaceSkills {
  const root = realpathSync(workingDir);
  const diagnostics: string[] = [];
  let config: RuntimeSkillsConfig;
  try { config = readUserConfigFileSync(options.configFile)?.skills ?? options.defaults; }
  catch (error) {
    // Keep the policy loaded at startup rather than dropping every ban.
    diagnostics.push(`Skill config unreadable, using the startup policy: ${error instanceof Error ? error.message : String(error)}`);
    config = options.defaults;
  }
  const policy = compatibility ? config.cloudWorkspaces?.find(p => p.workingDir === root) : undefined;
  const enabled = policy?.projectSkillsEnabled ?? true;
  let globalRoot = resolve(options.globalDir);
  try { globalRoot = realpathSync(globalRoot); } catch { /* Missing/error diagnostics are handled below. */ }
  const byName = new Map<string, WorkspaceSkill[]>();
  const dirs = [options.projectDirName, ...(compatibility ? [".agents/skills", ".claude/skills", ".cursor/skills", ".pi/skills"] : [])];
  const sources = [...dirs.map(dir => ({ dir: resolve(root, dir), source: "project" as const, claude: dir === ".claude/skills" })),
    { dir: resolve(options.globalDir), source: "global" as const, claude: false }];
  const visited = new Set<string>();
  let bytes = 0;
  let count = 0;
  let entryCapHit = false;
  let bytesCapHit = false;
  for (const source of sources) {
    if (entryCapHit) break;
    let dir: string;
    try { dir = realpathSync(source.dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push(`${source.dir}: ${String(error)}`); continue; }
    if (source.source === "project" && !isWithinWorkspace(root, dir)) { diagnostics.push(`${source.dir}: outside workspace`); continue; }
    // Preserve the existing global classification when both roots are identical.
    if (source.source === "project" && dir === globalRoot) continue;
    if (visited.has(dir)) continue;
    visited.add(dir);
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch (error) { diagnostics.push(`${dir}: ${String(error)}`); continue; }
    for (const name of names) {
      if (++count > 4096) {
        entryCapHit = true;
        diagnostics.push("Workspace skill discovery stopped at 4096 entries; later skills were not loaded. Narrow the skill directories.");
        break;
      }
      const manifestPath = join(dir, name, "SKILL.md");
      try {
        if (bytesCapHit) continue;
        // Project skills stay confined to the workspace. A global skill may be a symlink
        // to a folder elsewhere (as the local registry allows), so it is confined to its
        // own resolved folder instead of the global directory.
        let skillRoot = root;
        if (source.source === "global") {
          try { skillRoot = realpathSync(join(dir, name)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        }
        const file = readWorkspaceFile(skillRoot, manifestPath);
        if (!file) continue;
        if (bytes + Buffer.byteLength(file.content) > 8 * 1024 * 1024) {
          bytesCapHit = true;
          diagnostics.push(`Skill manifests exceed 8 MiB; skipped ${manifestPath} and later skills.`);
          continue;
        }
        bytes += Buffer.byteLength(file.content);
        const parsed = parseSkillFile(file.content, compatibility ? (source.claude ? { fallbackName: name } : {}) : undefined);
        if (!isSkillEligibleForPlatform(parsed.manifest, process.platform)) continue;
        if (parsed.disableModelInvocation) diagnostics.push(`Skill ${parsed.manifest.name} at ${file.path}: disable-model-invocation excludes automatic loading.`);
        const reasons = [
          ...(config.disabled.includes(parsed.manifest.name) ? ["disabled globally"] : []),
          ...(policy?.disabled.includes(parsed.manifest.name) ? ["disabled in workspace"] : []),
          ...(source.source === "project" && !enabled ? ["project skills disabled"] : []),
          ...(parsed.disableModelInvocation ? ["disable-model-invocation"] : []),
        ];
        const entry: WorkspaceSkill = { record: { manifest: parsed.manifest, manifestPath: file.path, rootDir: dirname(file.path), source: source.source },
          body: parsed.body, fingerprint: createHash("sha256").update(file.content).digest("hex"), disabledReasons: reasons, sources: [manifestPath] };
        const copies = byName.get(parsed.manifest.name) ?? [];
        copies.push(entry); byName.set(parsed.manifest.name, copies);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") diagnostics.push(`${manifestPath}: ${String(error)}`);
      }
    }
  }
  const entries = [...byName.values()].map(copies => {
    // A global copy wins: a checked-out repository cannot shadow a skill the user installed.
    const chosen = copies.find(e => e.record.source === "global") ?? copies[0]!;
    const sources = copies.flatMap(e => e.sources);
    if (copies.some(e => e.fingerprint !== chosen.fingerprint)) diagnostics.push(`Skill ${chosen.record.manifest.name}: using ${chosen.record.manifestPath}; shadowed ${sources.filter(p => p !== chosen.record.manifestPath).join(", ")}`);
    return { ...chosen, sources };
  }).sort((a, b) => a.record.manifest.name.localeCompare(b.record.manifest.name));
  return { workingDir: root, projectSkillsEnabled: enabled, entries, diagnostics,
    assertAvailable(name: string) {
      const original = entries.find(e => e.record.manifest.name === name);
      const current = loadWorkspaceSkills(root, options, compatibility).entries.find(e => e.record.manifest.name === name);
      if (!current || current.disabledReasons.length) throw new Error(`Skill ${name} unavailable: ${current?.disabledReasons.join(", ") ?? "not installed"}`);
      if (!original || current.record.manifestPath !== original.record.manifestPath || current.fingerprint !== original.fingerprint) throw new Error(`Skill ${name} changed since this request; refresh context before using it.`);
      return original;
    } };
}
