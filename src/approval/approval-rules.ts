import { createHash } from "node:crypto";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";

import type { ApprovalRequest } from "./approval-gate.js";
import {
  APPROVAL_CATEGORY_LABELS,
  isGrantableCategory,
  type ApprovalCategory,
} from "./approval-level.js";
import { isInside } from "./fanout-scope.js";

/**
 * Saved approval rules (ATO-1141 / ATO-33): standing answers the operator
 * gave once — "always allow `git status` in this project", "never run
 * `rm` here", "always ask before `npm publish`" — kept in a JSON file so
 * they outlive the session and the process, unlike a session grant.
 *
 * This module is pure: types, parsing / validation and matching. Reading
 * and writing the files is `approval-rules-store.ts`; applying a match is
 * `ApprovalGate.request`.
 *
 * Two files feed the rules:
 *  - global `<stateDir>/approval-rules.json`: allow, ask and deny, each
 *    optionally scoped to one project (`project`). It is part of the
 *    agent's trust surface, so a write to it asks as `trust_config` and a
 *    read as `state_secret`, like `config.json`.
 *  - project `<workdir>/.atomic-agent/approval-rules.json`: only `ask` and
 *    `deny` are honoured. The model can write files in the workspace at
 *    level 2, so an `allow` there would let it grant itself permissions.
 */

export type ApprovalRuleDecision = "allow" | "ask" | "deny";

/** Who made a rule: the "Allow always" choice of a prompt, or a person editing the file. */
export type ApprovalRuleSource = "prompt" | "user";

export interface ApprovalRule {
  /** Stable id, used by `DELETE /api/approval-rules/:id`. */
  id: string;
  decision: ApprovalRuleDecision;
  /** Exact tool name (`os.shell.run`). */
  tool?: string;
  category?: ApprovalCategory;
  /**
   * Shell only: argv token prefix of the command. argv[0] is compared by
   * basename (case-insensitively), the rest exactly. An allow rule needs
   * the request's `commandArgv`; a deny or ask rule also matches any
   * command in `commandSegments`, so a compound line, a binary named by
   * path or a dangerous command cannot step round it, and any request
   * marked `commandUnreadable` (a script piped into a shell).
   */
  commandPrefix?: string[];
  /** Every path the request names must be inside this directory. */
  path?: string;
  /** Only for sessions whose working directory is inside this one. */
  project?: string;
  createdAt: string;
  source: ApprovalRuleSource;
  note?: string;
}

/** A rule before the store gives it an id and a timestamp. */
export type NewApprovalRule = Omit<ApprovalRule, "id" | "createdAt"> & {
  createdAt?: string;
};

export const APPROVAL_RULES_FILE_VERSION = 1;

export interface ApprovalRulesFile {
  version: typeof APPROVAL_RULES_FILE_VERSION;
  rules: ApprovalRule[];
}

/** Where a rules file came from; a project file honours only ask and deny. */
export type ApprovalRulesOrigin = "global" | "project";

export interface ParsedApprovalRules {
  rules: ApprovalRule[];
  /** One line per entry that was skipped, for the log. */
  warnings: string[];
}

/** The file is not a rules file at all (not an object, no `rules` array). */
export class ApprovalRulesFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRulesFormatError";
  }
}

const DECISIONS: ReadonlySet<string> = new Set(["allow", "ask", "deny"]);

/**
 * Parse a rules file's JSON value. A file that is not a rules file throws
 * `ApprovalRulesFormatError` (the store then treats it as empty and logs);
 * a single bad entry is skipped with a warning, so one typo does not drop
 * every other rule.
 */
export function parseApprovalRulesFile(
  raw: unknown,
  origin: ApprovalRulesOrigin,
): ParsedApprovalRules {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ApprovalRulesFormatError("expected a JSON object");
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== undefined && record.version !== APPROVAL_RULES_FILE_VERSION) {
    throw new ApprovalRulesFormatError(
      `unsupported version ${JSON.stringify(record.version)}`,
    );
  }
  if (!Array.isArray(record.rules)) {
    throw new ApprovalRulesFormatError("expected a `rules` array");
  }
  const rules: ApprovalRule[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  record.rules.forEach((entry, index) => {
    const parsed = parseApprovalRule(entry);
    if (typeof parsed === "string") {
      warnings.push(`rule #${index + 1} skipped: ${parsed}`);
      return;
    }
    if (origin === "project" && parsed.decision === "allow") {
      warnings.push(
        `rule #${index + 1} skipped: a project file cannot allow; put "allow always" rules in the global file`,
      );
      return;
    }
    if (seen.has(parsed.id)) {
      warnings.push(`rule #${index + 1} skipped: duplicate id ${parsed.id}`);
      return;
    }
    seen.add(parsed.id);
    rules.push(parsed);
  });
  return { rules, warnings };
}

/**
 * Validate one rule entry. Returns the rule, or why it was rejected. A
 * missing `id` is derived from the rule's content, so a hand-written rule
 * keeps the same id across reloads and can still be deleted by id.
 */
export function parseApprovalRule(entry: unknown): ApprovalRule | string {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return "not an object";
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.decision !== "string" || !DECISIONS.has(e.decision)) {
    return 'decision must be "allow", "ask" or "deny"';
  }
  const decision = e.decision as ApprovalRuleDecision;
  const rule: Omit<ApprovalRule, "id" | "createdAt" | "source"> = { decision };
  if (e.tool !== undefined) {
    if (typeof e.tool !== "string" || e.tool.trim() === "") return "tool must be a non-empty string";
    rule.tool = e.tool.trim();
  }
  if (e.category !== undefined) {
    if (typeof e.category !== "string" || !isKnownCategory(e.category)) {
      return `unknown category ${JSON.stringify(e.category)}`;
    }
    rule.category = e.category;
  }
  if (e.commandPrefix !== undefined) {
    if (
      !Array.isArray(e.commandPrefix) ||
      e.commandPrefix.length === 0 ||
      !e.commandPrefix.every((t) => typeof t === "string" && t.length > 0)
    ) {
      return "commandPrefix must be a non-empty array of non-empty strings";
    }
    // `shell` and its sibling shell categories (`shell_dangerous`).
    if (rule.category !== undefined && !rule.category.startsWith("shell")) {
      return "commandPrefix applies to shell commands only";
    }
    rule.commandPrefix = [...(e.commandPrefix as string[])];
  }
  for (const key of ["path", "project"] as const) {
    const value = e[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !isAbsolute(value)) {
      return `${key} must be an absolute path`;
    }
    rule[key] = resolvePath(value);
  }
  // An allow that names nothing would silence every grantable prompt in
  // one line; that is what approval level 5 is for, not a rule.
  if (
    decision === "allow" &&
    rule.tool === undefined &&
    rule.category === undefined &&
    rule.commandPrefix === undefined
  ) {
    return "an allow rule must name a tool, a category or a commandPrefix";
  }
  if (e.note !== undefined && typeof e.note !== "string") return "note must be a string";
  const source: ApprovalRuleSource = e.source === "prompt" ? "prompt" : "user";
  const createdAt = typeof e.createdAt === "string" ? e.createdAt : "";
  const id =
    typeof e.id === "string" && e.id.trim() !== ""
      ? e.id.trim()
      : contentRuleId(rule);
  return {
    id,
    ...rule,
    createdAt,
    source,
    ...(typeof e.note === "string" ? { note: e.note } : {}),
  };
}

function isKnownCategory(value: string): value is ApprovalCategory {
  return Object.prototype.hasOwnProperty.call(APPROVAL_CATEGORY_LABELS, value);
}

/** A stable id for a rule written without one: a hash of what it matches. */
function contentRuleId(rule: Omit<ApprovalRule, "id" | "createdAt" | "source">): string {
  const key = JSON.stringify([
    rule.decision,
    rule.tool ?? null,
    rule.category ?? null,
    rule.commandPrefix ?? null,
    rule.path ?? null,
    rule.project ?? null,
  ]);
  return `r_${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}

/** Two rules that match exactly the same requests the same way. */
export function sameRuleScope(a: NewApprovalRule, b: NewApprovalRule): boolean {
  return (
    a.decision === b.decision &&
    a.tool === b.tool &&
    a.category === b.category &&
    JSON.stringify(a.commandPrefix ?? null) === JSON.stringify(b.commandPrefix ?? null) &&
    a.path === b.path &&
    a.project === b.project
  );
}

export interface RuleMatchContext {
  /**
   * The session's working directory in canonical form (realpath), or
   * undefined when unknown. With no workdir, a `project` rule is treated
   * conservatively: an ask / deny still applies, an allow does not.
   */
  workdir?: string;
}

export interface RuleMatch {
  decision: ApprovalRuleDecision;
  rule: ApprovalRule;
}

type MatchableRequest = Pick<
  ApprovalRequest,
  | "tool"
  | "category"
  | "commandArgv"
  | "commandSegments"
  | "commandUnreadable"
  | "targetPaths"
  | "affectedResources"
>;

/** The tool a command rule is written against. */
const SHELL_TOOL = "os.shell.run";

/**
 * The rule that decides `request`, or null when none matches.
 * Precedence: any matching deny, then any matching ask, then any matching
 * allow. An allow never applies to a category that is never granted
 * (`isGrantableCategory`), whatever the file says.
 */
export function matchRules(
  rules: readonly ApprovalRule[],
  request: MatchableRequest,
  ctx: RuleMatchContext = {},
): RuleMatch | null {
  let ask: ApprovalRule | null = null;
  let allow: ApprovalRule | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule, request, ctx)) continue;
    if (rule.decision === "deny") return { decision: "deny", rule };
    if (rule.decision === "ask") ask ??= rule;
    else if (isGrantableCategory(request.category)) allow ??= rule;
  }
  if (ask) return { decision: "ask", rule: ask };
  if (allow) return { decision: "allow", rule: allow };
  return null;
}

/** Whether every field `rule` sets matches `request`. */
export function ruleMatches(
  rule: ApprovalRule,
  request: MatchableRequest,
  ctx: RuleMatchContext = {},
): boolean {
  // A deny or ask on a command stands for that command however it is
  // started: by another tool that runs commands (`verify.run`), or
  // classed as dangerous rather than plain `shell`.
  const tightens = rule.decision !== "allow" && rule.commandPrefix !== undefined;
  if (
    rule.tool !== undefined &&
    rule.tool !== request.tool &&
    !(tightens && rule.tool === SHELL_TOOL && request.commandSegments !== undefined)
  ) {
    return false;
  }
  if (
    rule.category !== undefined &&
    rule.category !== request.category &&
    !(tightens && rule.category === "shell" && request.category === "shell_dangerous")
  ) {
    return false;
  }
  if (rule.commandPrefix !== undefined && !commandMatches(rule, rule.commandPrefix, request)) {
    return false;
  }
  if (rule.path !== undefined && !allPathsInside(request, rule.path)) return false;
  if (rule.project !== undefined) {
    if (ctx.workdir === undefined) return rule.decision !== "allow";
    if (!isInside(rule.project, resolvePath(ctx.workdir))) return false;
  }
  return true;
}

function commandMatches(
  rule: ApprovalRule,
  prefix: readonly string[],
  request: MatchableRequest,
): boolean {
  if (argvHasPrefix(request.commandArgv, prefix)) return true;
  if (rule.decision === "allow") return false;
  // A script piped into `sh` could be the very command the rule names.
  if (request.commandUnreadable === true) return true;
  return (request.commandSegments ?? []).some((words) => argvHasPrefix(words, prefix));
}

function argvHasPrefix(
  argv: readonly string[] | undefined,
  prefix: readonly string[],
): boolean {
  if (argv === undefined || argv.length < prefix.length) return false;
  return prefix.every((token, i) =>
    i === 0
      ? commandName(argv[0]!) === commandName(token)
      : argv[i] === token,
  );
}

/** argv[0] as a rule compares it: basename, lowercased (`/usr/bin/Git` → `git`). */
function commandName(token: string): string {
  return basename(token).toLowerCase();
}

function allPathsInside(request: MatchableRequest, dir: string): boolean {
  const paths = [...(request.targetPaths ?? []), ...(request.affectedResources ?? [])];
  if (paths.length === 0) return false;
  return paths.every((p) => isAbsolute(p) && isInside(dir, resolvePath(p)));
}

/**
 * A word that names a subcommand (`status`, `run-script`), not a flag, a
 * path or a file name: only then does "Allow always" key on two tokens.
 */
function isSubcommandWord(token: string | undefined): boolean {
  return token !== undefined && /^[a-z][a-z0-9-]*$/i.test(token);
}

/**
 * The argv prefix an "Allow always" of a shell command keys on: the
 * binary and its subcommand (`git status`) when argv[1] is a subcommand
 * word, else the binary alone (`ls -la` → `ls`).
 */
function alwaysCommandPrefix(request: ApprovalRequest): string[] | null {
  const argv = request.commandArgv;
  if (request.category !== "shell" || argv === undefined || argv.length === 0) return null;
  return isSubcommandWord(argv[1])
    ? [commandName(argv[0]!), argv[1]!]
    : [commandName(argv[0]!)];
}

/**
 * The allow rule "Allow always" saves for `request`, built from the
 * request itself (never from what a host sends), or null when the
 * request cannot take one (see `canGrantAlways`). `project` is the
 * caller's canonical form of `request.workdir`.
 */
export function buildAlwaysRule(
  request: ApprovalRequest,
  project: string | undefined = request.workdir,
): NewApprovalRule | null {
  if (!canGrantAlways(request) || project === undefined) return null;
  const prefix = alwaysCommandPrefix(request);
  if (request.category === "shell") {
    if (prefix === null) return null;
    return {
      decision: "allow",
      tool: request.tool,
      category: "shell",
      commandPrefix: prefix,
      project,
      source: "prompt",
    };
  }
  const readRoot = request.category === "fs_read_outside" ? alwaysReadRoot(request) : undefined;
  return {
    decision: "allow",
    tool: request.tool,
    category: request.category,
    ...(readRoot !== undefined ? { path: readRoot } : {}),
    project,
    source: "prompt",
  };
}

/**
 * The directory an "Allow always" of a read outside the project covers:
 * the one the prompt named. Without it the rule would open every file on
 * the machine to this project, for good.
 */
function alwaysReadRoot(request: ApprovalRequest): string | undefined {
  const root = request.affectedResources?.[0];
  return root !== undefined && isAbsolute(root) ? root : undefined;
}

/**
 * Whether a prompt may offer "Allow always" for `request`, judged on the
 * request alone: a grantable category, a known session working directory
 * (the rule is scoped to that project), and for a shell command the argv
 * the rule keys on. A host that holds the gate asks
 * `ApprovalGate.canGrantAlways`, which also needs a rules store installed.
 */
export function canGrantAlways(request: ApprovalRequest): boolean {
  if (!isGrantableCategory(request.category)) return false;
  if (request.workdir === undefined || request.workdir === "") return false;
  if (request.category === "shell") {
    return (request.commandArgv?.length ?? 0) > 0;
  }
  // A rule cannot say "this one file in home": it would cover any file
  // there, `.zshrc` included, from then on.
  if (request.category === "fs_write_home") return false;
  if (request.category === "fs_read_outside") return alwaysReadRoot(request) !== undefined;
  return true;
}

/** The text an "Allow always" choice shows: `Always allow "git status" in this project`. */
export function describeAlwaysRule(request: ApprovalRequest): string {
  const prefix = alwaysCommandPrefix(request);
  if (prefix !== null) {
    return `Always allow "${prefix.join(" ")}" in this project`;
  }
  const under = request.category === "fs_read_outside" ? alwaysReadRoot(request) : undefined;
  return `Always allow ${request.tool} (${APPROVAL_CATEGORY_LABELS[request.category]})${
    under !== undefined ? ` under ${under}` : ""
  } in this project`;
}

/** One line naming what a rule matches, for a denial reason or a list. */
export function describeRule(rule: ApprovalRule): string {
  const parts: string[] = [rule.decision];
  if (rule.commandPrefix !== undefined) parts.push(`"${rule.commandPrefix.join(" ")}"`);
  else if (rule.tool !== undefined) parts.push(rule.tool);
  if (rule.category !== undefined && rule.commandPrefix === undefined) {
    parts.push(`(${APPROVAL_CATEGORY_LABELS[rule.category]})`);
  }
  if (rule.path !== undefined) parts.push(`under ${rule.path}`);
  if (rule.project !== undefined) parts.push(`in project ${rule.project}`);
  if (parts.length === 1) parts.push("everything");
  return parts.join(" ");
}
