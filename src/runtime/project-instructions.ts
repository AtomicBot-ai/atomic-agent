import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { readWorkspaceFile, isWithinWorkspace } from "../skills/workspace-files.js";

export interface ProjectInstruction { path: string; scope: string; body: string; priority: number }
export interface GitResult { status: number | null; stdout?: string; stderr?: string; error?: Error }
export interface ProjectInstructionOptions {
  /** Test seam: runs git in the workspace with a cleaned environment. */
  runGit?: (root: string, args: string[], input?: string) => GitResult;
  maxEntries?: number;
  maxFiles?: number;
  maxBytes?: number;
}
const names = new Set(["AGENTS.md", "AGENT.md", "CLAUDE.md"]);
const excluded = new Set([".git", "node_modules"]);
// The fallback walk has no .gitignore, so it also skips common dependency/build trees.
const walkExcluded = new Set([...excluded, ".venv", "venv", "vendor", "dist", "build", "target", ".next", "__pycache__"]);
// Imports never pull credentials into the prompt, ignored by Git or not.
const sensitiveName = /^(\.env(\..*)?|\.npmrc|\.netrc|\.pgpass|\.pypirc|\.git-credentials|credentials\.json|id_(rsa|dsa|ecdsa|ed25519)(\..*)?|.*\.(pem|key|p12|pfx|tfvars|kdbx))$/i;
function isSensitive(relPath: string): boolean {
  const parts = relPath.split("/");
  return sensitiveName.test(parts[parts.length - 1]!) || parts.includes(".aws") || relPath === ".docker/config.json" || relPath.endsWith("/.docker/config.json");
}
const maxListed = 5;

export function runGitInWorkspace(root: string, args: string[], input?: string): GitResult {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
  return spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args],
    { cwd: root, env, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true, ...(input !== undefined ? { input } : {}) });
}

/** Groups repeated diagnostics so prose mentions cannot flood the prompt. */
class Diagnostics {
  private readonly groups = new Map<string, string[]>();
  add(category: string, item?: string): void {
    const items = this.groups.get(category) ?? [];
    if (item !== undefined && !items.includes(item)) items.push(item);
    this.groups.set(category, items);
  }
  lines(): string[] {
    return [...this.groups].map(([category, items]) => {
      if (!items.length) return category;
      const more = items.length > maxListed ? ` and ${items.length - maxListed} more` : "";
      return `${category}: ${items.slice(0, maxListed).join(", ")}${more}`;
    });
  }
}

/**
 * Bounded, synchronous preparation preserves the existing pure/synchronous preview API.
 * Instruction problems never fail a step: bad files are skipped and caps truncate, with diagnostics.
 */
export function loadProjectInstructions(workingDir: string, signal?: AbortSignal, options: ProjectInstructionOptions = {}): { instructions: ProjectInstruction[]; diagnostics: string[] } {
  signal?.throwIfAborted();
  const diagnostics = new Diagnostics();
  try {
    return { instructions: loadInstructions(workingDir, diagnostics, signal, options), diagnostics: diagnostics.lines() };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    diagnostics.add(`Project instructions unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return { instructions: [], diagnostics: diagnostics.lines() };
  }
}

function loadInstructions(workingDir: string, diagnostics: Diagnostics, signal: AbortSignal | undefined, options: ProjectInstructionOptions): ProjectInstruction[] {
  const root = realpathSync(workingDir);
  const runGit = options.runGit ?? runGitInWorkspace;
  const maxFiles = options.maxFiles ?? 512;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const rel = (path: string) => relative(root, path).split("\\").join("/") || ".";
  const git = runGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "AGENTS.md", "AGENT.md", "CLAUDE.md", ":(glob)**/AGENTS.md", ":(glob)**/AGENT.md", ":(glob)**/CLAUDE.md"]);
  const gitMode = git.status === 0;
  let paths: string[];
  if (gitMode) paths = (git.stdout ?? "").split("\0").filter(Boolean);
  else {
    // Not a repository, no git binary, or git refusing the folder (for example
    // safe.directory ownership checks): the bounded filesystem walk still works.
    const missing = (git.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" || /not a git repository/i.test(git.stderr ?? "");
    if (!missing) diagnostics.add(`Git instruction discovery failed, scanning files instead: ${(git.error?.message ?? git.stderr ?? "").trim().split("\n")[0]}`);
    paths = walk(root, diagnostics, signal, options.maxEntries ?? 100_000);
  }
  // Root names are checked directly, even if ignored; absent ones take no file slot.
  paths.push(...["AGENTS.md", "AGENT.md", "CLAUDE.md", ".claude/CLAUDE.md"].filter(p => existsSync(join(root, p))));
  paths = [...new Set(paths)].filter(p => !p.split(/[\\/]/).some(part => excluded.has(part)));
  if (paths.length > maxFiles) {
    // Shallower scopes are the most general rules; keep those.
    paths.sort((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length || a.localeCompare(b));
    diagnostics.add(`Project instructions exceed ${maxFiles} files; deeper files were not loaded. Narrow the workspace.`);
    paths = paths.slice(0, maxFiles);
  }
  const contents = new Map<string, { path: string; content: string }>();
  /** Reads once per step; the import pre-pass and the real pass share it. */
  function readOnce(actual: string): { path: string; content: string } | null {
    const cached = contents.get(actual);
    if (cached) return cached;
    const file = readWorkspaceFile(root, actual);
    if (file) contents.set(actual, file);
    return file;
  }
  const ignoredImports = gitMode ? classifyImports() : null;
  /**
   * One `git check-ignore` per step: a pre-pass collects every import that could
   * be read, then Git classifies them together. Unclassified imports fail closed.
   */
  function classifyImports(): { candidates: Set<string>; ignored: Set<string> | "all" } {
    const candidates = new Set<string>();
    const visitedDepth = new Map<string, number>();
    let scanned = 0;
    const visit = (path: string, depth: number): void => {
      signal?.throwIfAborted();
      // Beyond this, imports stay unclassified and are skipped by the real pass.
      if (depth > 4 || scanned > 8 * maxBytes || !isWithinWorkspace(root, path)) return;
      let actual: string;
      try { actual = realpathSync(path); } catch { return; }
      if (!isWithinWorkspace(root, actual) || (depth > 0 && isSensitive(rel(actual)))) return;
      if ((visitedDepth.get(actual) ?? Infinity) <= depth) { if (depth > 0 && contents.has(actual)) candidates.add(rel(actual)); return; }
      visitedDepth.set(actual, depth);
      let file: { path: string; content: string } | null;
      try { file = statSync(actual).isFile() ? readOnce(actual) : null; } catch { return; }
      if (!file || file.content.includes("\0")) return;
      scanned += file.content.length;
      if (depth > 0) candidates.add(rel(actual));
      if (basename(path) !== "CLAUDE.md" && depth === 0) return;
      for (const target of instructionImports(file.content)) if (!target.startsWith("~")) visit(resolve(dirname(actual), target), depth + 1);
    };
    for (const path of paths) visit(resolve(root, path), 0);
    if (!candidates.size) return { candidates, ignored: new Set() };
    const check = runGit(root, ["check-ignore", "-z", "--stdin"], [...candidates].join("\0") + "\0");
    if (check.status === 1) return { candidates, ignored: new Set() };
    if (check.status !== 0) {
      diagnostics.add(`Git could not classify instruction imports; skipping them: ${(check.error?.message ?? check.stderr ?? "").trim().split("\n")[0]}`);
      return { candidates, ignored: "all" };
    }
    return { candidates, ignored: new Set((check.stdout ?? "").split("\0").filter(Boolean)) };
  }
  function gitIgnores(path: string): boolean {
    if (!ignoredImports) return false;
    const key = rel(path);
    return ignoredImports.ignored === "all" || !ignoredImports.candidates.has(key) || ignoredImports.ignored.has(key);
  }
  const instructions: ProjectInstruction[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let budgetHit = false;
  function read(path: string, label: string, scope: string, priority: number, depth: number, stack: Set<string>): void {
    signal?.throwIfAborted();
    if (!isWithinWorkspace(root, path)) { diagnostics.add("Skipped external instruction", label); return; }
    let actual: string;
    try { actual = realpathSync(path); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // `@name` in prose is often a mention or a package scope, not an import.
      if (code === "ENOENT" || code === "ENOTDIR") { if (depth > 0) diagnostics.add("Skipped missing instruction imports", label); }
      else diagnostics.add("Skipped unreadable instruction", `${label} (${code ?? String(error)})`);
      return;
    }
    if (!isWithinWorkspace(root, actual)) { diagnostics.add("Skipped external instruction", label); return; }
    if (stack.has(actual)) { diagnostics.add("Instruction import cycle", rel(actual)); return; }
    const key = `${scope}\0${actual}`;
    if (seen.has(key)) return;
    if (depth > 4) { diagnostics.add("Skipped instruction imports beyond four hops", rel(actual)); return; }
    if (depth > 0 && isSensitive(rel(actual))) { diagnostics.add("Skipped sensitive instruction import", rel(actual)); return; }
    let file: { path: string; content: string } | null;
    try {
      if (!statSync(actual).isFile()) { diagnostics.add("Skipped non-file instruction", rel(actual)); return; }
      if (depth > 0 && gitIgnores(actual)) { diagnostics.add("Skipped ignored or unclassified instruction import", rel(actual)); return; }
      file = readOnce(actual);
    } catch (error) {
      diagnostics.add("Skipped unreadable instruction", `${rel(actual)} (${(error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message.replace(root, ".") : String(error))})`);
      return;
    }
    if (!file) return;
    if (file.content.includes("\0")) { diagnostics.add("Skipped binary instruction", rel(actual)); return; }
    const size = Buffer.byteLength(file.content);
    if (budgetHit || bytes + size > maxBytes || instructions.length >= maxFiles) {
      budgetHit = true;
      diagnostics.add(`Project instructions exceed ${maxBytes} bytes or ${maxFiles} files; skipped`, rel(actual));
      return;
    }
    bytes += size;
    seen.add(key);
    instructions.push({ path: actual, scope, body: file.content, priority });
    if (basename(path) === "CLAUDE.md" || depth > 0) {
      const nextStack = new Set(stack).add(actual);
      for (const target of instructionImports(file.content)) {
        if (target.startsWith("~")) { diagnostics.add("Skipped home instruction imports", target); continue; }
        read(resolve(dirname(actual), target), target, scope, priority, depth + 1, nextStack);
      }
    }
  }
  // Shallow scopes first, so the byte and file budgets keep the most general rules
  // (and their imports); within a scope, higher precedence first, which also
  // determines the label of a deduplicated import.
  const scopeOf = (path: string) => {
    const dir = dirname(path);
    return (basename(path) === "CLAUDE.md" && basename(dir) === ".claude" ? dirname(dir) : dir).split("\\").join("/");
  };
  const depthOf = (scope: string) => scope === "." ? 0 : scope.split("/").length;
  paths.sort((a, b) => depthOf(scopeOf(a)) - depthOf(scopeOf(b)) || priorityOf(b) - priorityOf(a) || a.localeCompare(b));
  for (const path of paths) read(resolve(root, path), path, scopeOf(path), priorityOf(path), 0, new Set());
  instructions.sort((a, b) => a.scope.split("/").length - b.scope.split("/").length || a.scope.localeCompare(b.scope) || b.priority - a.priority || a.path.localeCompare(b.path));
  return instructions;
}

function priorityOf(path: string): number {
  return basename(path) === "AGENTS.md" ? 4 : basename(path) === "AGENT.md" ? 3 : basename(dirname(path)) === ".claude" ? 1 : 2;
}

function walk(root: string, diagnostics: Diagnostics, signal: AbortSignal | undefined, maxEntries: number): string[] {
  const paths: string[] = [];
  const pending = [root];
  let count = 0;
  while (pending.length) {
    signal?.throwIfAborted();
    const dir = pending.pop()!;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) { diagnostics.add("Skipped unreadable directories", `${relative(root, dir).split("\\").join("/") || "."} (${(error as NodeJS.ErrnoException).code ?? String(error)})`); continue; }
    for (const entry of entries) {
      if (++count > maxEntries) {
        diagnostics.add(`Project instruction scan stopped at ${maxEntries} entries; nested instructions beyond that point were not loaded. Narrow the workspace or use Git.`);
        return paths;
      }
      if (walkExcluded.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (names.has(entry.name)) paths.push(relative(root, path));
    }
  }
  return paths;
}

export function instructionImports(body: string): string[] {
  const plain: string[] = [];
  let fence: string | undefined;
  let indentedCode = false;
  let previousBlank = true;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; previousBlank = false; continue; }
    if (fence) continue;
    const blank = line.trim() === "";
    // An indented code block starts after a blank line and continues through blank lines.
    indentedCode = /^( {4}|\t)/.test(line) ? indentedCode || previousBlank : indentedCode && blank;
    previousBlank = blank;
    if (!indentedCode) plain.push(line);
  }
  const text = plain.join("\n").replace(/(`+)[\s\S]*?\1/g, "");
  return [...text.matchAll(/(?:^|[\s(])@((?:\\ |[^\s`"'<>])+)/g)].map(match => match[1]!.replace(/\\ /g, " ").replace(/[),;]+$/, ""));
}
