import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { readWorkspaceFile, isWithinWorkspace } from "../skills/workspace-files.js";

export interface ProjectInstruction { path: string; scope: string; body: string; priority: number }
const names = new Set(["AGENTS.md", "AGENT.md", "CLAUDE.md"]);
const excluded = new Set([".git", "node_modules"]);

/** Bounded, synchronous preparation preserves the existing pure/synchronous preview API. */
export function loadProjectInstructions(workingDir: string, signal?: AbortSignal): { instructions: ProjectInstruction[]; diagnostics: string[] } {
  signal?.throwIfAborted();
  const root = realpathSync(workingDir);
  const diagnostics: string[] = [];
  const gitEnv = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete gitEnv[key];
  const git = spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "AGENTS.md", "AGENT.md", "CLAUDE.md", ":(glob)**/AGENTS.md", ":(glob)**/AGENT.md", ":(glob)**/CLAUDE.md"],
    { cwd: root, env: gitEnv, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true });
  let paths: string[];
  if (git.status === 0) paths = git.stdout.split("\0").filter(Boolean);
  else if ((git.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" || /not a git repository/i.test(git.stderr ?? "")) paths = walk(root, signal);
  else throw new Error(`Project instruction discovery failed: ${git.error?.message ?? git.stderr}`);
  paths.push("AGENTS.md", "AGENT.md", "CLAUDE.md", ".claude/CLAUDE.md");
  paths = [...new Set(paths)].filter(p => !p.split(/[\\/]/).some(part => excluded.has(part))).sort();
  if (paths.length > 512) throw new Error("Project instructions exceed 512 files; narrow the workspace.");
  const instructions: ProjectInstruction[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  function read(path: string, scope: string, priority: number, depth: number, stack: Set<string>, required = false): void {
    signal?.throwIfAborted();
    if (!isWithinWorkspace(root, path)) { diagnostics.push(`Skipped external instruction: ${path}`); return; }
    let actual: string;
    try { actual = realpathSync(path); }
    catch (error) { if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!isWithinWorkspace(root, actual)) { diagnostics.push(`Skipped external instruction: ${path}`); return; }
    if (stack.has(actual)) { diagnostics.push(`Instruction import cycle: ${path}`); return; }
    const key = `${scope}\0${actual}`;
    if (seen.has(key)) return;
    if (depth > 4) throw new Error(`Instruction imports exceed four hops: ${path}`);
    const file = readWorkspaceFile(root, actual);
    if (!file) throw new Error(`Instruction disappeared while loading: ${path}`);
    bytes += Buffer.byteLength(file.content);
    if (bytes > 1024 * 1024 || instructions.length >= 512) throw new Error("Project instructions exceed 1 MiB or 512 files; narrow the workspace. No instructions were truncated.");
    seen.add(key);
    instructions.push({ path: actual, scope, body: file.content, priority });
    if (basename(path) === "CLAUDE.md" || depth > 0) {
      const nextStack = new Set(stack).add(actual);
      for (const target of instructionImports(file.content)) {
        if (target.startsWith("~")) { diagnostics.push(`Skipped home instruction import: ${target}`); continue; }
        read(resolve(dirname(actual), target), scope, priority, depth + 1, nextStack, true);
      }
    }
  }
  // Higher precedence first also determines the label of a deduplicated import.
  paths.sort((a, b) => priorityOf(b) - priorityOf(a) || a.localeCompare(b));
  for (const path of paths) {
    const dir = dirname(path);
    const scope = basename(path) === "CLAUDE.md" && basename(dir) === ".claude" ? dirname(dir) : dir;
    read(resolve(root, path), scope.split("\\").join("/"), priorityOf(path), 0, new Set());
  }
  instructions.sort((a, b) => a.scope.split("/").length - b.scope.split("/").length || a.scope.localeCompare(b.scope) || b.priority - a.priority || a.path.localeCompare(b.path));
  return { instructions, diagnostics };
}

function priorityOf(path: string): number {
  return basename(path) === "AGENTS.md" ? 4 : basename(path) === "AGENT.md" ? 3 : basename(dirname(path)) === ".claude" ? 1 : 2;
}

function walk(root: string, signal?: AbortSignal): string[] {
  const paths: string[] = [];
  const pending = [root];
  let count = 0;
  while (pending.length) {
    signal?.throwIfAborted();
    const dir = pending.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++count > 100_000) throw new Error("Project instruction scan exceeds 100000 entries; narrow the workspace.");
      if (excluded.has(entry.name)) continue;
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
  for (const line of body.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; continue; }
    if (!fence) plain.push(line);
  }
  const text = plain.join("\n").replace(/(`+)[\s\S]*?\1/g, "");
  return [...text.matchAll(/(?:^|[\s(])@((?:\\ |[^\s`"'<>])+)/g)].map(match => match[1]!.replace(/\\ /g, " ").replace(/[),;]+$/, ""));
}
