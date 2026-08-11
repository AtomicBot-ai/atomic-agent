/**
 * Five-step approval ladder. Level 1 keeps the historical behaviour of
 * `approvalRequired: true` (every gated action asks first); level 5 is
 * the old "approve everything" switch (nothing asks). Levels 2..4 stop
 * asking for progressively broader categories - see the table below.
 *
 * Hardline shell-guard rules are NOT part of this ladder: they fire
 * before the gate and block at every level.
 */
export type ApprovalLevel = 1 | 2 | 3 | 4 | 5;

export const MIN_APPROVAL_LEVEL: ApprovalLevel = 1;
export const MAX_APPROVAL_LEVEL: ApprovalLevel = 5;

/**
 * Closed set of request categories. Every `requireApproval` call site
 * names one; the compiler enforces the list stays exhaustive. `other`
 * is the conservative fallback for anything a call site cannot place
 * precisely - it keeps asking on every level except 5.
 */
export type ApprovalCategory =
  | "fs_write_workspace"
  | "fs_write_home"
  | "fs_trash"
  | "http"
  | "shell"
  | "script"
  | "proc_kill"
  | "browser_nonweb"
  | "trust_config"
  | "other";

/**
 * The level at which a category stops asking. O(1) lookup on the gate's
 * hot path. Cumulative by construction: a category silent at level N is
 * silent at every level above N because the check is `level >= entry`.
 *
 *  - level 2 (workspace): file writes/edits/patches strictly inside the
 *    session working directory (realpath containment).
 *  - level 3 (home): file writes anywhere under the home directory,
 *    moves to Trash, archive extraction, HTTP requests (the SSRF guard
 *    is not part of the gate and stays on).
 *  - level 4 (operator): guarded shell commands, skill scripts,
 *    process kills.
 *  - level 5 (full trust): everything, including browser navigation to
 *    non-web URLs, writes to the agent's own trust config, and
 *    uncategorised requests.
 *
 * `trust_config` is deliberately pinned at 5: a write to the file that
 * holds `agent.approvalLevel` (or the `.env` holding API tokens) is the
 * one action that can silently raise the ladder for the *next* boot, so
 * it must never go silent below full trust. Otherwise a model at level
 * 3 or 4 could rewrite its own config to level 5 without a prompt and
 * escalate itself across a restart. See `fs-approval-scope.ts`.
 */
const AUTO_APPROVE_FROM_LEVEL: Record<ApprovalCategory, ApprovalLevel> = {
  fs_write_workspace: 2,
  fs_write_home: 3,
  fs_trash: 3,
  http: 3,
  shell: 4,
  script: 4,
  proc_kill: 4,
  browser_nonweb: 5,
  trust_config: 5,
  other: 5,
};

/**
 * Clamp an arbitrary number into a valid `ApprovalLevel`. Non-finite
 * input falls back to the strictest level (1) - conservative default.
 * Runtime surfaces (hot-apply, slash commands, boot flags) clamp here;
 * the config parser validates strictly instead (`parseUserConfigFile`).
 */
export function clampApprovalLevel(raw: number): ApprovalLevel {
  if (!Number.isFinite(raw)) return MIN_APPROVAL_LEVEL;
  const truncated = Math.trunc(raw);
  if (truncated < MIN_APPROVAL_LEVEL) return MIN_APPROVAL_LEVEL;
  if (truncated > MAX_APPROVAL_LEVEL) return MAX_APPROVAL_LEVEL;
  return truncated as ApprovalLevel;
}

/** True when `category` runs without a prompt at `level`. */
export function isAutoApprovedAt(
  level: ApprovalLevel,
  category: ApprovalCategory,
): boolean {
  return level >= AUTO_APPROVE_FROM_LEVEL[category];
}

/**
 * Whether a session grant (`[s]` / `[a]` in the prompt) may silence this
 * category for the rest of the session. Everything is grantable except
 * `trust_config`: a write to `config.json` / `.env` is the one action
 * that can silently raise the ladder for the next boot, so it must keep
 * asking even if the operator granted a broad category earlier. Pinned
 * at level 5 in `AUTO_APPROVE_FROM_LEVEL` for the same reason; this is
 * the grant-side half of that invariant. The single source of truth for
 * "never grantable": the gate reads it on both the grant and the
 * auto-approve path.
 */
export function isGrantableCategory(category: ApprovalCategory): boolean {
  return category !== "trust_config";
}

/**
 * Short human label for a request category, shown next to an approval
 * prompt so a host / operator sees *why* the ladder stopped here (a
 * `file write · home` prompt reads very differently from a
 * `trust config` one). Kept alongside the union so a new category forces
 * a label here too — the compiler walks the record.
 */
export const APPROVAL_CATEGORY_LABELS: Record<ApprovalCategory, string> = {
  fs_write_workspace: "file write · workspace",
  fs_write_home: "file write · home",
  fs_trash: "move to Trash",
  http: "HTTP request",
  shell: "shell command",
  script: "skill script",
  proc_kill: "process kill",
  browser_nonweb: "browser · non-web URL",
  trust_config: "agent trust config",
  other: "uncategorised",
};

/** `"file write · home"` — the display label for a category. */
export function formatApprovalCategory(category: ApprovalCategory): string {
  return APPROVAL_CATEGORY_LABELS[category];
}

/** Human names for the five levels, used across TUI and CLI surfaces. */
export const APPROVAL_LEVEL_NAMES: Record<ApprovalLevel, string> = {
  1: "paranoid",
  2: "workspace",
  3: "home",
  4: "operator",
  5: "full trust",
};

/** "2 (workspace)" - the canonical short label. */
export function formatApprovalLevel(level: ApprovalLevel): string {
  return `${level} (${APPROVAL_LEVEL_NAMES[level]})`;
}

/**
 * Boot-time level resolution shared by `run`, `tui`, and `serve`: the
 * persisted `agent.approvalLevel` is the baseline and `--no-approval`
 * can only force level 5 (approve everything) for this process, never
 * a stricter level. Same one-directional contract the flag had for the
 * binary switch: it can only lower strictness for one run.
 */
export function resolveBootApprovalLevel(
  noApproval: boolean,
  configuredLevel: number,
): ApprovalLevel {
  if (noApproval) return MAX_APPROVAL_LEVEL;
  return clampApprovalLevel(configuredLevel);
}
