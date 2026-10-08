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

export function loadWorkspaceSkills(workingDir: string, options: WorkspaceSkillsOptions, compatibility = true): WorkspaceSkills {
  const root = realpathSync(workingDir);
  const config = readUserConfigFileSync(options.configFile)?.skills ?? options.defaults;
  const policy = compatibility ? config.cloudWorkspaces?.find(p => p.workingDir === root) : undefined;
  const enabled = policy?.projectSkillsEnabled ?? true;
  const diagnostics: string[] = [];
  let globalRoot = resolve(options.globalDir);
  try { globalRoot = realpathSync(globalRoot); } catch { /* Missing/error diagnostics are handled below. */ }
  const byName = new Map<string, WorkspaceSkill[]>();
  const dirs = [options.projectDirName, ...(compatibility ? [".agents/skills", ".claude/skills", ".cursor/skills", ".pi/skills"] : [])];
  const sources = [...dirs.map(dir => ({ dir: resolve(root, dir), source: "project" as const, claude: dir === ".claude/skills" })),
    { dir: resolve(options.globalDir), source: "global" as const, claude: false }];
  const visited = new Set<string>();
  let bytes = 0;
  let count = 0;
  for (const source of sources) {
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
      if (++count > 4096) throw new Error("Workspace skill discovery exceeded 4096 entries; narrow the skill directories.");
      const manifestPath = join(dir, name, "SKILL.md");
      try {
        const file = readWorkspaceFile(source.source === "project" ? root : dir, manifestPath);
        if (!file) continue;
        bytes += Buffer.byteLength(file.content);
        if (bytes > 8 * 1024 * 1024) throw new Error("Skill manifests exceed 8 MiB.");
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
        if (bytes > 8 * 1024 * 1024) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") diagnostics.push(`${manifestPath}: ${String(error)}`);
      }
    }
  }
  const entries = [...byName.values()].map(copies => {
    const chosen = (!enabled ? copies.find(e => e.record.source === "global") : undefined) ?? copies[0]!;
    const sources = copies.flatMap(e => e.sources);
    if (copies.some(e => e.fingerprint !== chosen.fingerprint)) diagnostics.push(`Skill ${chosen.record.manifest.name}: using ${chosen.record.manifestPath}; shadowed ${sources.filter(p => p !== chosen.record.manifestPath).join(", ")}`);
    return { ...chosen, sources };
  }).sort((a, b) => a.record.manifest.name.localeCompare(b.record.manifest.name));
  return { workingDir: root, projectSkillsEnabled: enabled, entries, diagnostics,
    assertAvailable(name) {
      const original = entries.find(e => e.record.manifest.name === name);
      const current = loadWorkspaceSkills(root, options, compatibility).entries.find(e => e.record.manifest.name === name);
      if (!current || current.disabledReasons.length) throw new Error(`Skill ${name} unavailable: ${current?.disabledReasons.join(", ") ?? "not installed"}`);
      if (!original || current.record.manifestPath !== original.record.manifestPath || current.fingerprint !== original.fingerprint) throw new Error(`Skill ${name} changed since this request; refresh context before using it.`);
      return original;
    } };
}
