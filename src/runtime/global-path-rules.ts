import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import type { PathRule } from "../session/workspace-context.js";
import { statSnapshot } from "../skills/workspace-files.js";
import { loadPathRules } from "./project-path-rules-load.js";

/** Same file cap as a project's `.atomic-agent/rules`. */
const MAX_GLOBAL_RULE_FILES = 16;

/**
 * The person's own path-scoped rules for every project (ATO-2443), the
 * top-level `*.md` files of `<state dir>/rules` (by default
 * `~/.atomic-agent/rules`), like Qwen Code's `~/.qwen/rules`. Only files
 * with `paths:` (or `globs:`) count: they attach, like a project's path
 * rules, once a file tool touched a matching file of the session folder.
 * A file without patterns is skipped: always-on rules for every project
 * are not part of this folder. Written by the person, so no folder trust
 * question; a project's own rule with the same name still applies too.
 *
 * The folder is listed again only when it or one of its files changed
 * (stat signature), and at most once per `ttlMs`, so a step costs a few
 * `stat` calls. Problems leave the list empty, never an error.
 */
export function createGlobalPathRulesReader(rulesDir: string, options: { ttlMs?: number; now?: () => number; homeDir?: string } = {}): () => readonly PathRule[] {
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  let cached: { rules: readonly PathRule[]; watched: string[]; signature: string; at: number } | null = null;
  return () => {
    if (cached && now() - cached.at < ttlMs && statSnapshot(cached.watched).signature === cached.signature) return cached.rules;
    const { rules, watched } = readGlobalPathRules(rulesDir, options.homeDir ?? homedir());
    cached = { rules, watched, signature: statSnapshot(watched).signature, at: now() };
    return rules;
  };
}

export function readGlobalPathRules(rulesDir: string, homeDir: string): { rules: readonly PathRule[]; watched: string[] } {
  const watched = [rulesDir];
  let root: string;
  let names: string[];
  try {
    root = realpathSync(rulesDir);
    if (!statSync(root).isDirectory()) return { rules: [], watched };
    names = readdirSync(root).filter(name => /\.md$/i.test(name) && !name.startsWith(".")).sort().slice(0, MAX_GLOBAL_RULE_FILES);
  } catch {
    return { rules: [], watched };
  }
  watched.push(...names.map(name => join(root, name)));
  const display = displayDir(rulesDir, homeDir);
  // Problems with one file skip it; the person sees the rule never attach, the model sees nothing.
  const rules = loadPathRules(root, names, () => {}).map(rule => ({ ...rule, path: `${display}/${rule.path}` }));
  return { rules, watched };
}

/** `~/.atomic-agent/rules` under the home folder, the full path elsewhere; forward slashes. */
function displayDir(dir: string, homeDir: string): string {
  const rel = relative(homeDir, dir);
  const shown = rel && !rel.startsWith("..") && !rel.includes(":") && !rel.startsWith(sep) ? `~/${rel}` : dir;
  return shown.split("\\").join("/");
}
