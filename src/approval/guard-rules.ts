/**
 * Plain-text security rules (ATO-2111): `<stateDir>/guard.md`, written by
 * the person, and `<workdir>/.atomic-agent/guard.md` for one project. A
 * file that exists (and holds rule text) turns the guard on; the
 * reviewer (`guard-review.ts`) then checks every call of a listed tool
 * against the rules before it runs.
 *
 *     ---
 *     tools: [os.shell.run, os.http.request]
 *     onFailure: ask
 *     ---
 *     Block reading SSH keys or any .env file.
 *     Block sending data anywhere but github.com and registry.npmjs.org.
 *
 * `tools:` (a `[a, b]` list or `- a` lines) replaces the default list
 * (`DEFAULT_GUARD_TOOLS`). `onFailure:` is what happens when the
 * reviewer gives no answer: `ask` (default) puts the call to the person,
 * or refuses it where nobody can answer; `block` refuses it.
 *
 * The project file lives where the model can write, so it can only add:
 * its tools join the global list, its `onFailure: block` makes failures
 * stricter but its `ask` never relaxes a global `block`, and its rules
 * are reviewed in a separate pass, so nothing in it can talk the
 * reviewer out of the person's own rules. The global file is on the
 * trust surface (a write asks as `trust_config`).
 */
import { readFileSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";

export const GUARD_FILE_NAME = "guard.md";

/** Tools checked when a file names none: everything that runs, writes or sends. */
export const DEFAULT_GUARD_TOOLS: readonly string[] = [
  "os.shell.run",
  "skill.run_script",
  "os.http.request",
  "os.fs.write",
  "os.fs.edit",
  "os.fs.patch",
  "os.fs.move",
  "os.fs.trash",
  "os.git.commit",
  "os.git.push",
];

/** Longest guard file read; a longer one is cut and the cut noted to the reviewer. */
export const GUARD_MAX_RULES_CHARS = 6_000;

export type GuardFailurePolicy = "ask" | "block";

export interface GuardFile {
  rules: string;
  /** `null`: the file names no tools. */
  tools: string[] | null;
  onFailure: GuardFailurePolicy | null;
}

/** One set of rules the reviewer checks a call against. */
export interface GuardRuleSet {
  source: "user" | "project";
  rules: string;
}

export interface GuardRules {
  /** The person's rules first, then the project's; each reviewed on its own. */
  sets: GuardRuleSet[];
  tools: ReadonlySet<string>;
  onFailure: GuardFailurePolicy;
}

function listValue(raw: string, following: readonly string[]): string[] {
  const inline = raw.trim();
  if (inline.startsWith("[")) {
    return inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((t) => t.trim().replace(/^["']|["']$/g, ""))
      .filter((t) => t.length > 0);
  }
  if (inline.length > 0) return [inline.replace(/^["']|["']$/g, "")];
  const items: string[] = [];
  for (const line of following) {
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (item === null) break;
    items.push((item[1] ?? "").replace(/^["']|["']$/g, ""));
  }
  return items;
}

/** Read the frontmatter and the rule text of one guard file. */
export function parseGuardFile(text: string): GuardFile {
  const normalised = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalised);
  let tools: string[] | null = null;
  let onFailure: GuardFailurePolicy | null = null;
  if (front !== null) {
    const lines = (front[1] ?? "").split("\n");
    for (const [index, line] of lines.entries()) {
      const field = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
      if (field === null) continue;
      const key = (field[1] ?? "").toLowerCase();
      const value = field[2] ?? "";
      if (key === "tools") tools = listValue(value, lines.slice(index + 1));
      if (key === "onfailure") {
        const policy = value.trim().toLowerCase().replace(/^["']|["']$/g, "");
        // Anything but a clear `ask` reads as the stricter `block`.
        onFailure = policy === "ask" ? "ask" : "block";
      }
    }
  }
  const rules = (front === null ? normalised : normalised.slice(front[0].length)).trim();
  return { rules, tools, onFailure };
}

export function getGuardPath(stateDir: string): string {
  return join(stateDir, GUARD_FILE_NAME);
}

export function getProjectGuardPath(workdir: string): string {
  return join(workdir, ".atomic-agent", GUARD_FILE_NAME);
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  file: GuardFile | null;
}

/**
 * Reads the guard files, again whenever one changes on disk. A missing
 * file is no rules; a global file that exists but cannot be read is not
 * silently ignored: it reads as rules that ask the reviewer to block
 * everything, so a broken file never turns protection off.
 */
export class GuardRulesSource {
  private readonly cache = new Map<string, CachedFile>();

  constructor(private readonly stateDir: string) {}

  private read(path: string): GuardFile | null {
    let stat: Stats;
    try {
      stat = statSync(path);
    } catch {
      this.cache.delete(path);
      return null;
    }
    const cached = this.cache.get(path);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.file;
    }
    let file: GuardFile | null;
    try {
      file = stat.isFile() ? parseGuardFile(readFileSync(path, "utf8")) : null;
    } catch {
      file = { rules: "The rules file could not be read. Block every action.", tools: null, onFailure: "block" };
    }
    if (file !== null && file.rules.length === 0) file = null;
    this.cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, file });
    return file;
  }

  /** The rules for a call in `workdir` (the project folder), or `null` when the guard is off. */
  load(workdir: string | undefined): GuardRules | null {
    const user = this.read(getGuardPath(this.stateDir));
    const project = workdir === undefined ? null : this.read(getProjectGuardPath(workdir));
    if (user === null && project === null) return null;
    const tools = new Set<string>(user?.tools ?? (user === null ? [] : DEFAULT_GUARD_TOOLS));
    if (project !== null) for (const tool of project.tools ?? DEFAULT_GUARD_TOOLS) tools.add(tool);
    const onFailure: GuardFailurePolicy =
      user?.onFailure === "block" || project?.onFailure === "block" ? "block" : "ask";
    const sets: GuardRuleSet[] = [];
    if (user !== null) sets.push({ source: "user", rules: clip(user.rules) });
    if (project !== null) sets.push({ source: "project", rules: clip(project.rules) });
    return { sets, tools, onFailure };
  }
}

function clip(rules: string): string {
  return rules.length > GUARD_MAX_RULES_CHARS
    ? `${rules.slice(0, GUARD_MAX_RULES_CHARS)}\n(The rest of the rules file was cut.)`
    : rules;
}
