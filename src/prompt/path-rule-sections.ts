import { isAbsolute, relative, resolve } from "node:path";
import type { ConversationTurn } from "../session/conversation-turn.js";
import type { PathRule } from "../session/workspace-context.js";
import { compileGlob } from "../tools/os/fs/fs-glob-pattern.js";

/**
 * Path-scoped project rules (ATO-2247): a rule joins the prompt once a file
 * tool in this session read or changed a file its patterns match, and stays
 * for the rest of the session. The answer is derived from the append-only
 * transcript, so it never needs its own state and is the same on resume.
 * The sections go through the cloud context journal, which appends them after
 * the conversation: the stable prefix never changes.
 */

/** File tools whose arguments name the file they read or change. */
const pathArgs: Record<string, (args: Record<string, unknown>) => unknown[]> = {
  "os.fs.read": args => [args.path],
  "os.fs.read_document": args => [args.path],
  "os.fs.write": args => [args.path],
  "os.fs.edit": args => [args.path],
  "os.fs.move": args => [args.from, args.to, ...(Array.isArray(args.moves)
    ? args.moves.flatMap(move => move && typeof move === "object" ? [(move as Record<string, unknown>).from, (move as Record<string, unknown>).to] : [])
    : [])],
};

/** Workspace-relative paths (forward slashes) the session's file tools touched, oldest first. */
export function touchedWorkspacePaths(turns: readonly ConversationTurn[], roots: readonly string[]): string[] {
  const out = new Set<string>();
  for (const turn of turns) {
    if (turn.kind !== "assistant_tool_call") continue;
    const pick = pathArgs[turn.tool];
    if (!pick) continue;
    for (const value of pick(turn.args ?? {})) {
      if (typeof value !== "string" || !value.trim() || value.startsWith("~")) continue;
      const rel = workspaceRelative(value.trim(), roots);
      if (rel) out.add(rel);
    }
  }
  return [...out];
}

function workspaceRelative(path: string, roots: readonly string[]): string | null {
  for (const root of roots) {
    const rel = relative(root, resolve(root, path)).split("\\").join("/");
    if (rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) return rel;
    if (!isAbsolute(path)) return null;
  }
  return null;
}

/**
 * True when `relPath` matches one of the patterns. A pattern without `/`
 * matches a file name in any folder (`*.sql`), as in Cursor and `.gitignore`;
 * one with `/` matches from the workspace root (`db/**`, `./db/*.sql`).
 */
export function pathRuleMatches(patterns: readonly string[], relPath: string): boolean {
  return patterns.some(raw => {
    const pattern = raw.replace(/^\.\//, "").replace(/^\//, "");
    if (!pattern) return false;
    const glob = pattern.includes("/") ? pattern : `**/${pattern}`;
    try { return compileGlob(glob).test(relPath); } catch { return false; }
  });
}

/** Rules some touched path matches, in rule order. */
export function activePathRules(rules: readonly PathRule[], turns: readonly ConversationTurn[], roots: readonly string[]): PathRule[] {
  if (!rules.length) return [];
  const touched = touchedWorkspacePaths(turns, roots);
  return rules.filter(rule => touched.some(path => pathRuleMatches(rule.patterns, path)));
}

/** The journal body of an attached rule: its source, why it applies, then its text. */
export function renderPathRule(rule: PathRule): string {
  return `Source: ${rule.path}\nApplies to files matching: ${rule.patterns.join(", ")} (relative to workspace). Attached because a matching file was opened or changed in this session; follow it when working on such files.\n${rule.body}`;
}
