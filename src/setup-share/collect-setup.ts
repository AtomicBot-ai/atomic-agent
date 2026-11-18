import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MAX_PROFILE_FILE_BYTES, USER_AGENT_DIR_NAME } from "../agent-profiles/index.js";
import { buildShareableConfig, looksLikeKey, type ShareableConfig } from "./redact-setup-config.js";
import {
  CONFIG_NAME,
  MAX_FILE_BYTES,
  isAllowedBundlePath,
  isCredentialFileName,
  isSkippedDirName,
} from "./setup-bundle-format.js";

/**
 * ATO-1073: what of the state dir goes into a shared setup, picked by an
 * allow-list the way Hermes exports its default profile, so a file that
 * happens to sit in `~/.atomic-agent` (chats, memory, logs, caches, the
 * `.env` with keys, MCP OAuth tokens, installs) can never be swept in.
 *
 * Read from the state dir:
 *  - `config.json`, reduced and redacted (redact-setup-config.ts);
 *  - `skills/<name>/` with a SKILL.md, minus the bundled starter skills,
 *    VCS/install folders, credential-looking files, symlinks, files
 *    over MAX_FILE_BYTES and text files with a key-shaped value in them;
 *  - `agents/*.md`, the subagent profiles (also left out when one holds
 *    a key-shaped value).
 * Scheduled jobs are rows in `tasks.sqlite`, not files, so they are not
 * part of this first version.
 */
export interface CollectedFile {
  /** Bundle-relative path (`skills/x/SKILL.md`). */
  path: string;
  /** Absolute source on disk. */
  abs: string;
  size: number;
}

export interface CollectedSetup {
  share: ShareableConfig;
  skills: string[];
  agents: string[];
  files: CollectedFile[];
  leftOut: string[];
}

export interface CollectSetupInput {
  stateDir: string;
  /** Bundled starter skill names; re-seeded on every boot, so never shared. */
  starterSkills: ReadonlySet<string>;
}

function readConfig(stateDir: string): Record<string, unknown> {
  const path = join(stateDir, CONFIG_NAME);
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function sortedEntries(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

const KEY_IN_FILE = "looks like it contains a key";

/**
 * Whether a text file carries something key-shaped (`sk-…`, `ghp_…`).
 * Skill scripts and profiles are copied byte for byte, so a key pasted
 * into one would otherwise travel with the setup. Binary files (a NUL
 * byte) are not scanned.
 */
function fileHoldsKey(abs: string): boolean {
  const bytes = readFileSync(abs);
  if (bytes.includes(0)) return false;
  return looksLikeKey(bytes.toString("utf8"));
}

function walkSkill(stateDir: string, rel: string, files: CollectedFile[], leftOut: string[]): void {
  for (const name of sortedEntries(join(stateDir, rel))) {
    const childRel = `${rel}/${name}`;
    const abs = join(stateDir, childRel);
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) {
      if (st) leftOut.push(`${childRel} (symlink)`);
      continue;
    }
    if (st.isDirectory()) {
      if (isSkippedDirName(name)) continue;
      walkSkill(stateDir, childRel, files, leftOut);
      continue;
    }
    if (!st.isFile()) continue;
    if (isCredentialFileName(name)) {
      leftOut.push(`${childRel} (looks like a credential or database file)`);
      continue;
    }
    if (st.size > MAX_FILE_BYTES) {
      leftOut.push(`${childRel} (over ${MAX_FILE_BYTES / 1024 / 1024} MB)`);
      continue;
    }
    if (!isAllowedBundlePath(childRel)) {
      leftOut.push(`${childRel} (unusual file name)`);
      continue;
    }
    if (fileHoldsKey(abs)) {
      leftOut.push(`${childRel} (${KEY_IN_FILE})`);
      continue;
    }
    files.push({ path: childRel, abs, size: st.size });
  }
}

export function collectSetup(input: CollectSetupInput): CollectedSetup {
  const { stateDir } = input;
  const files: CollectedFile[] = [];
  const leftOut: string[] = [];
  const skills: string[] = [];
  for (const name of sortedEntries(join(stateDir, "skills"))) {
    const dir = join(stateDir, "skills", name);
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (!st?.isDirectory() || !existsSync(join(dir, "SKILL.md"))) continue;
    if (input.starterSkills.has(name)) continue;
    if (!isAllowedBundlePath(`skills/${name}/SKILL.md`)) {
      leftOut.push(`skills/${name} (unusual folder name)`);
      continue;
    }
    const before = files.length;
    walkSkill(stateDir, `skills/${name}`, files, leftOut);
    if (files.slice(before).some((f) => f.path === `skills/${name}/SKILL.md`)) skills.push(name);
    else files.length = before;
  }
  const agents: string[] = [];
  for (const name of sortedEntries(join(stateDir, USER_AGENT_DIR_NAME))) {
    const rel = `agents/${name}`;
    const abs = join(stateDir, USER_AGENT_DIR_NAME, name);
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st?.isFile() || !name.endsWith(".md")) continue;
    if (st.size > MAX_PROFILE_FILE_BYTES || !isAllowedBundlePath(rel)) {
      leftOut.push(`${rel} (too large or unusual name)`);
      continue;
    }
    if (fileHoldsKey(abs)) {
      leftOut.push(`${rel} (${KEY_IN_FILE})`);
      continue;
    }
    files.push({ path: rel, abs, size: st.size });
    agents.push(name.slice(0, -3));
  }
  return { share: buildShareableConfig(readConfig(stateDir)), skills, agents, files, leftOut };
}
