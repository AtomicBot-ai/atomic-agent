import { isAbsolute, relative, resolve } from "node:path";
import type { ConversationTurn } from "../session/conversation-turn.js";
import type { PathRule } from "../session/workspace-context.js";
import { compileGlob } from "../tools/os/fs/fs-glob-pattern.js";
import { turnTargetPaths } from "./path-rule-tool-targets.js";
import { estimateTokens, truncateToTokens } from "./token-budget.js";

/**
 * Path-scoped project rules (ATO-2247): a rule joins the prompt once a file
 * tool in this session read or changed a file its patterns match, and stays
 * for the rest of the session. The answer is derived from the append-only
 * transcript, so it never needs its own state and is the same on resume.
 * The sections go through the cloud context journal, which appends them after
 * the conversation: the stable prefix never changes.
 */

/** Workspace-relative paths (forward slashes) the session's file tools touched, oldest first. */
export function touchedWorkspacePaths(turns: readonly ConversationTurn[], roots: readonly string[]): string[] {
  const out = new Set<string>();
  for (const turn of turns) {
    for (const value of turnTargetPaths(turn)) {
      if (!value.trim() || value.startsWith("~")) continue;
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

/**
 * Rules the step's new turns attached: active after it, not before
 * (ATO-2443). `after` extends `before` (the transcript is append-only), so
 * a rule is reported once, on the step whose file tool matched it first.
 */
export function newlyActivePathRules(rules: readonly PathRule[], before: readonly ConversationTurn[], after: readonly ConversationTurn[], roots: readonly string[]): PathRule[] {
  if (!rules.length || after.length <= before.length) return [];
  const was = new Set(activePathRules(rules, before, roots).map(rule => rule.path));
  return activePathRules(rules, after, roots).filter(rule => !was.has(rule.path));
}

/** The most a local prompt gives attached path rules, in tokens. */
export const LOCAL_PATH_RULES_MAX_TOKENS = 2048;
/** Share of a known local window attached path rules may take. */
const LOCAL_PATH_RULES_WINDOW_SHARE = 0.05;
const LOCAL_PATH_RULES_MIN_TOKENS = 256;

/**
 * The local prompt's room for attached path rules (ATO-2443): at most
 * {@link LOCAL_PATH_RULES_MAX_TOKENS}, and 5% of a known window, so a 16K
 * model gives them about 800 tokens and keeps the rest for the work.
 */
export function localPathRulesBudget(contextWindow: number | null | undefined): number {
  if (!contextWindow || contextWindow <= 0) return LOCAL_PATH_RULES_MAX_TOKENS;
  return Math.max(LOCAL_PATH_RULES_MIN_TOKENS, Math.min(LOCAL_PATH_RULES_MAX_TOKENS, Math.floor(contextWindow * LOCAL_PATH_RULES_WINDOW_SHARE)));
}

/**
 * The local prompt's `### project-rules` body: every attached rule, in rule
 * order, or null when none is attached. It goes in the tail after the
 * conversation (`build-prompt.ts`), never in the stable prefix, and only
 * changes on the step a new rule attaches.
 */
export function renderLocalPathRules(rules: readonly PathRule[], turns: readonly ConversationTurn[], roots: readonly string[]): string | null {
  const active = activePathRules(rules, turns, roots);
  return active.length ? active.map(renderPathRule).join("\n\n") : null;
}

const clippedMarker = "\n[... truncated: project rules budget reached]";

/** The section cut to `maxTokens` with a visible marker, so the model knows a rule is incomplete. */
export function clipLocalPathRules(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  return truncateToTokens(text, Math.max(0, maxTokens - estimateTokens(clippedMarker))) + clippedMarker;
}
