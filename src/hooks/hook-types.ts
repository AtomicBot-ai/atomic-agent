/**
 * Shapes shared by the hooks module. The on-disk format is the one Claude
 * Code uses in `hooks.json` / `settings.json`:
 *
 *   { "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [
 *       { "type": "command", "command": "./check.sh", "timeout": 30 } ] } ] } }
 */

/** Events the agent fires today. Other Claude events parse but never run. */
export const FIRED_HOOK_EVENTS = ["PreToolUse", "PostToolUse"] as const;

/** Every event name Claude Code documents; accepted in config without a diagnostic. */
export const KNOWN_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionStart",
  "SessionEnd",
] as const;

export type HookEventName = (typeof KNOWN_HOOK_EVENTS)[number];
export type ToolHookEvent = (typeof FIRED_HOOK_EVENTS)[number];

/** Claude's default per-command timeout. */
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

/** Where a hook came from: the user's own file or an installed plugin. */
export type HookSource =
  | { kind: "user"; file: string }
  | { kind: "plugin"; plugin: string; root: string; data: string };

export interface HookCommand {
  type: "command";
  /** Shell command line; `${CLAUDE_PLUGIN_ROOT}` already expanded for plugin hooks. */
  command: string;
  timeoutMs: number;
  source: HookSource;
}

export interface HookMatcherGroup {
  /** The matcher as written; empty or absent matches every tool. */
  matcher: string;
  hooks: HookCommand[];
}

export type HookConfig = Partial<Record<HookEventName, HookMatcherGroup[]>>;

export interface LoadedHooks {
  config: HookConfig;
  /** One line per skipped file, plugin or entry; never an exception. */
  diagnostics: string[];
}

/** What a single hook command, or several combined, decided. */
export type HookDecision = "allow" | "deny" | "ask" | "none";

export interface HookVerdict {
  decision: HookDecision;
  /** Why: stderr on exit 2, or the JSON reason fields. */
  reason?: string;
  /** Text a PostToolUse hook wants the model to read with the result. */
  feedback?: string;
  /** A hook that failed, timed out or printed bad JSON. The call is not blocked by it. */
  error?: string;
}

export function describeHookSource(source: HookSource): string {
  return source.kind === "user" ? `user hooks (${source.file})` : `plugin ${source.plugin}`;
}
