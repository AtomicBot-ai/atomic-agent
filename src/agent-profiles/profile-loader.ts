import { readdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ProjectTrustRecord } from "../config/skills-config.js";
import { instructionTrust, readProjectTrust } from "../skills/project-trust.js";
import { isWithinWorkspace, readWorkspaceFile } from "../skills/workspace-files.js";
import {
  MAX_PROFILE_FILE_BYTES,
  parseAgentProfileFile,
  type AgentProfile,
  type AgentProfileSource,
} from "./agent-profile.js";
import { BUILTIN_AGENT_PROFILES } from "./builtin-profiles.js";

/**
 * Where profiles come from, and which one wins a name (ATO-566):
 *
 *   trusted project > user (`<stateDir>/agents/*.md`) > plugin > built-in
 *
 * A trusted project's copy wins, as in Claude Code: the repository knows
 * what its `review` should check. That needs the operator's yes for that
 * file; an untrusted one is never read, so the user's copy applies. A
 * project's files are read
 * from `.atomic-agent/agents/` and then `.claude/agents/` (Claude Code's
 * folder, so a repo set up for it works as is), and only after the
 * operator trusted that file for this folder: each file is an item of
 * the folder's trust question, keyed by its workspace-relative path like
 * an instruction file (`src/skills/docs/project-trust.md`). A pending or
 * declined file is not read past discovery.
 *
 * Plugin profiles are named `plugin:agent`, so they never collide with
 * the other sources. Discovery problems are diagnostics, never errors.
 */
export const USER_AGENT_DIR_NAME = "agents";
export const PROJECT_AGENT_DIRS: readonly string[] = [".atomic-agent/agents", ".claude/agents"];
/** Files read per folder; a folder with more is cut there with a diagnostic. */
export const MAX_PROFILES_PER_DIR = 128;

export interface AgentProfileLoadOptions {
  workingDir: string;
  /** The agent's state directory; user profiles live in `<stateDir>/agents`. */
  stateDir: string;
  /** User config holding `skills.projectTrust`, reread for live answers. */
  configFile: string;
  /** Trust answers at startup, used when the config cannot be reread. */
  startupTrust: readonly ProjectTrustRecord[] | undefined;
  /** Enabled plugins' profiles, already parsed (`listPluginSubagents`). */
  pluginProfiles?: () => readonly AgentProfile[];
}

export interface AgentProfileSet {
  /** Every usable profile, by name. */
  profiles: AgentProfile[];
  get(name: string): AgentProfile | undefined;
  diagnostics: string[];
  /** Project files not loaded because the folder has not trusted them. */
  withheld: string[];
}

function markdownFiles(dir: string, diagnostics: string[]): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") diagnostics.push(`${dir}: ${String(err)}`);
    return [];
  }
  if (names.length > MAX_PROFILES_PER_DIR) {
    diagnostics.push(`${dir}: more than ${MAX_PROFILES_PER_DIR} profiles; only the first ${MAX_PROFILES_PER_DIR} were read`);
    return names.slice(0, MAX_PROFILES_PER_DIR);
  }
  return names;
}

/**
 * A project folder's profile directory, resolved, or null when it is
 * missing or (through a symlink) lies outside the workspace.
 */
function projectDir(root: string, rel: string, diagnostics: string[]): string | null {
  let dir: string;
  try {
    dir = realpathSync(resolve(root, rel));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push(`${rel}: ${String(err)}`);
    return null;
  }
  if (!isWithinWorkspace(root, dir)) {
    diagnostics.push(`${rel}: outside the workspace, not read`);
    return null;
  }
  return dir;
}

/** The user's profile folder, resolved; null when it does not exist. */
function resolvedUserDir(stateDir: string): string | null {
  try {
    return realpathSync(join(stateDir, USER_AGENT_DIR_NAME));
  } catch {
    return null;
  }
}

/**
 * Workspace-relative paths of the profile files a folder ships, for its
 * trust question. Nothing is read beyond the directory listing.
 */
export function listProjectAgentProfilePaths(workingDir: string, stateDir?: string): string[] {
  let root: string;
  try {
    root = realpathSync(workingDir);
  } catch {
    return [];
  }
  const userRoot = stateDir === undefined ? null : resolvedUserDir(stateDir);
  const ignored: string[] = [];
  const out: string[] = [];
  for (const rel of PROJECT_AGENT_DIRS) {
    const dir = projectDir(root, rel, ignored);
    if (dir === null || dir === userRoot) continue;
    for (const file of markdownFiles(dir, ignored)) out.push(`${rel}/${file}`);
  }
  return out;
}

function readProfile(
  root: string,
  path: string,
  source: AgentProfileSource,
  label: string,
  diagnostics: string[],
): AgentProfile | null {
  try {
    const file = readWorkspaceFile(root, path, MAX_PROFILE_FILE_BYTES);
    if (file === null) return null;
    const parsed = parseAgentProfileFile(file.content, basename(path, ".md"));
    if (!parsed.ok) {
      diagnostics.push(`agent profile ${label}: ${parsed.error}`);
      return null;
    }
    return { ...parsed.profile, source, file: file.path };
  } catch (err) {
    diagnostics.push(`agent profile ${label}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function profileSet(byName: Map<string, AgentProfile>, diagnostics: string[], withheld: string[]): AgentProfileSet {
  const profiles = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { profiles, get: (name) => byName.get(name.trim().toLowerCase()), diagnostics, withheld };
}

/** The built-ins alone: for a caller with no state directory (tests, embedders). */
export function builtinAgentProfileSet(): AgentProfileSet {
  return profileSet(new Map(BUILTIN_AGENT_PROFILES.map((p) => [p.name, p])), [], []);
}

export function loadAgentProfiles(options: AgentProfileLoadOptions): AgentProfileSet {
  const diagnostics: string[] = [];
  const withheld: string[] = [];
  const byName = new Map<string, AgentProfile>();
  /** First one in wins; a later copy of the name is reported as shadowed. */
  const offer = (profile: AgentProfile): void => {
    const existing = byName.get(profile.name);
    if (existing === undefined) {
      byName.set(profile.name, profile);
      return;
    }
    if (profile.source !== "builtin") {
      diagnostics.push(`agent profile ${profile.name}: ${profile.file ?? profile.source} is shadowed by ${existing.file ?? existing.source}`);
    }
  };

  // Project profiles: only files this folder's operator trusted. Opened
  // in the home folder, `.atomic-agent/agents` IS the user's folder: it
  // is read below as the user's, not asked about as a project's.
  const userRoot = resolvedUserDir(options.stateDir);
  let root: string | null = null;
  try {
    root = realpathSync(options.workingDir);
  } catch (err) {
    diagnostics.push(`${options.workingDir}: ${String(err)}`);
  }
  if (root !== null) {
    const record = readProjectTrust(options.configFile, options.startupTrust, root);
    for (const rel of PROJECT_AGENT_DIRS) {
      const dir = projectDir(root, rel, diagnostics);
      if (dir === null || dir === userRoot) continue;
      for (const file of markdownFiles(dir, diagnostics)) {
        const item = `${rel}/${file}`;
        if (instructionTrust(record, item) !== "trusted") {
          withheld.push(item);
          continue;
        }
        const profile = readProfile(root, join(dir, file), "project", item, diagnostics);
        if (profile !== null) offer(profile);
      }
    }
  }

  // User profiles: confined to the folder they resolve to.
  if (userRoot !== null) {
    for (const file of markdownFiles(userRoot, diagnostics)) {
      const profile = readProfile(userRoot, join(userRoot, file), "user", file, diagnostics);
      if (profile !== null) offer(profile);
    }
  }

  if (options.pluginProfiles !== undefined) {
    try {
      for (const profile of options.pluginProfiles()) offer({ ...profile, source: "plugin" });
    } catch (err) {
      diagnostics.push(`plugin agent profiles unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const profile of BUILTIN_AGENT_PROFILES) offer(profile);

  return profileSet(byName, diagnostics, withheld);
}
