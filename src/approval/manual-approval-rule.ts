import { checkShellCommandGuard } from "../tools/os/shell-command-guard/guard-engine.js";
import {
  NESTED_SHELL_PROGRAMS,
  PREFIX_COMMANDS,
  programName,
} from "../tools/os/shell-command-guard/command-segments.js";
import {
  APPROVAL_CATEGORY_LABELS,
  isGrantableCategory,
} from "./approval-level.js";
import {
  parseApprovalRule,
  type ApprovalRule,
  type NewApprovalRule,
} from "./approval-rules.js";
import { isSiteScopedCategory } from "./site-grants.js";

/**
 * A rule a person adds by hand (`POST /api/approval-rules`, ATO-1011),
 * the way Claude Code's `/permissions` adds `Bash(git status:*)` or a
 * path rule. It lands in the global rules file, so it may allow, ask or
 * deny. An allow may never cover more than "Allow always" would save
 * from a prompt: the same categories are refused (`canGrantAlways`),
 * and the fields a prompt always fills in (the command, the folder, the
 * site) are required here too.
 */

/** Fields a request body may carry; anything else is a typo and refused. */
const FIELDS: ReadonlySet<string> = new Set([
  "decision",
  "tool",
  "category",
  "commandPrefix",
  "path",
  "project",
  "origin",
  "note",
]);

const SHELL_TOOL = "os.shell.run";

/** Programs that run the command named after them (`sudo`, `env`, `bash -c`). */
const RUNS_OTHER_COMMANDS: ReadonlySet<string> = new Set([
  ...NESTED_SHELL_PROGRAMS,
  ...Object.keys(PREFIX_COMMANDS),
]);

/**
 * Validate a hand-made rule. Returns the rule to save (source `user`,
 * no id or timestamp: the store gives those), or a plain sentence
 * saying why it was refused.
 */
export function parseManualApprovalRule(body: unknown): NewApprovalRule | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "body must be a JSON object";
  }
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!FIELDS.has(key)) return `unknown field "${key}"`;
  }
  const entry: Record<string, unknown> = { ...input, source: "user" };
  // `{ decision: "allow", commandPrefix: ["git", "status"] }` is the
  // short form, like `Bash(git status:*)`: it means a shell command.
  if (entry.decision === "allow" && entry.commandPrefix !== undefined) {
    entry.category ??= "shell";
    entry.tool ??= SHELL_TOOL;
  }
  const parsed = parseApprovalRule(entry);
  if (typeof parsed === "string") return parsed;
  if (parsed.decision === "allow") {
    const refused = refuseAllow(parsed);
    if (refused !== null) return refused;
  }
  return toNewRule(parsed);
}

/** Why an allow rule cannot be saved, or null when it can. */
function refuseAllow(rule: ApprovalRule): string | null {
  const category = rule.category;
  if (category === undefined) {
    return "an allow rule must name a category, so it cannot reach prompts that are never allowed for good";
  }
  const label = APPROVAL_CATEGORY_LABELS[category];
  if (!isGrantableCategory(category)) {
    return `"${label}" is never allowed by a rule: it asks every time`;
  }
  if (category === "fs_write_home") {
    return "file writes in your home folder cannot be allowed by a rule: it would cover any file there, .zshrc included";
  }
  if (isSiteScopedCategory(category)) {
    return `"${label}" is allowed per site, for one chat only, not by a rule`;
  }
  if (category === "fs_read_outside" && rule.path === undefined) {
    return "an allow rule for reads outside the project needs a path: the folder it covers";
  }
  if ((category === "http" || category === "http_write") && rule.origin === undefined) {
    return "an allow rule for HTTP requests needs an origin, like https://api.example.com";
  }
  if (category === "shell") return refuseShellAllow(rule);
  // "Allow always" keys every rule on the tool that asked.
  if (rule.tool === undefined) {
    return `an allow rule must name the tool it covers, like "os.fs.write"`;
  }
  if (rule.commandPrefix !== undefined) {
    return "commandPrefix applies to shell commands only";
  }
  return null;
}

function refuseShellAllow(rule: ApprovalRule): string | null {
  const prefix = rule.commandPrefix;
  if (prefix === undefined) {
    return "an allow rule for shell commands needs a commandPrefix, like [\"git\", \"status\"]";
  }
  if (rule.tool !== undefined && rule.tool !== SHELL_TOOL) {
    return `an allow rule with a commandPrefix is for ${SHELL_TOOL}`;
  }
  const program = programName(prefix[0]!);
  if (RUNS_OTHER_COMMANDS.has(program)) {
    return `"${program}" runs other commands, so it cannot be allowed by a rule; allow the command itself`;
  }
  const verdict = checkShellCommandGuard({
    cmd: prefix[0]!,
    rawArgs: prefix.slice(1),
    cwd: rule.project ?? "/",
  });
  if (verdict.action === "block") {
    return `"${prefix.join(" ")}" is blocked by the shell guard and cannot be allowed`;
  }
  if (verdict.rule.startsWith("dangerous.")) {
    return `"${prefix.join(" ")}" is a dangerous command: it asks every time and cannot be allowed by a rule`;
  }
  return null;
}

function toNewRule(rule: ApprovalRule): NewApprovalRule {
  const next: NewApprovalRule & { id?: string } = { ...rule };
  delete next.id;
  delete next.createdAt;
  return next;
}
