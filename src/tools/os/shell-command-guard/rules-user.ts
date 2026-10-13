import type {
  GuardVerdict,
  NormalisedCommand,
  Rule,
  ShellGuardUserRules,
} from "./guard-types.js";
import { basenameCommand } from "./normalise.js";
import { hasShellMetachar } from "./rules-safe-allow.js";

export const USER_DENY_RULE = "user.deny";
export const USER_ALLOW_RULE = "user.allow";

/**
 * A compiled user pattern. Matching is deliberately dull (issue #229):
 * the first token is the normalised binary (argv[0], basename,
 * lowercased — the same unit the guard and shape grants key on), the
 * rest are matched against the args one token each, case-sensitively
 * (`-v` and `-V` mean different things, so a pattern must say which it
 * wants), and a lone trailing `*` covers every remaining argument
 * including none. A `*` inside a token is a within-one-argument glob —
 * never a regex, never a substring probe along the whole line.
 */
interface UserPattern {
  /** The pattern as written, for verdict reasons and /guard output. */
  readonly source: string;
  readonly binary: string;
  readonly argTokens: readonly string[];
  readonly trailingGlob: boolean;
}

/**
 * Build the user rule layer: deny first, then allow, both empty when
 * their lists are (so an unconfigured install adds no rules at all).
 * Returned in the order the engine must walk them — a deny verdict
 * outranks an allow for the same command, which is also the reading a
 * config with both implies.
 */
export function buildUserGuardRules(
  rules: ShellGuardUserRules | undefined,
): readonly Rule[] {
  if (!rules) return [];
  const deny = compileAll(rules.deny);
  const allow = compileAll(rules.allow);
  const layer: Rule[] = [];
  if (deny.length > 0) {
    layer.push({
      id: USER_DENY_RULE,
      layer: "user",
      match: (input) => matchDeny(deny, input),
    });
  }
  if (allow.length > 0) {
    layer.push({
      id: USER_ALLOW_RULE,
      layer: "user",
      match: (input) => matchAllow(allow, input),
    });
  }
  return layer;
}

/**
 * A deny hit forces the approval ladder: the command never runs
 * silently (beating safe-allow and the `default` fallthrough, which is
 * exactly what sits after this layer), and a declined or undeliverable
 * prompt surfaces as `ApprovalDeniedError`. The verdict is
 * `approval_required` rather than `block` on purpose — "narrow what
 * prompts", the scope the issue thread settled on; a user rule that
 * blocks outright is the discussed-but-deferred escape hatch.
 */
function matchDeny(
  patterns: readonly UserPattern[],
  input: NormalisedCommand,
): GuardVerdict | null {
  const pattern = findMatch(patterns, input);
  if (!pattern) return null;
  return {
    action: "approval_required",
    rule: USER_DENY_RULE,
    reason: `denied by your shell guard rule "${pattern.source}"`,
  };
}

/**
 * An allow hit runs the command without a prompt. Two guards keep an
 * allow from covering more than the operator typed: shell metachars
 * anywhere in the args disqualify the match (the same rule safe-allow
 * applies — a line the shell will reinterpret is not the command the
 * pattern names), and the built-in layers above this one were consulted
 * first, so no pattern can allow a hardline block or a dangerous
 * command past its own verdict.
 */
function matchAllow(
  patterns: readonly UserPattern[],
  input: NormalisedCommand,
): GuardVerdict | null {
  if (input.args.some(hasShellMetachar)) return null;
  const pattern = findMatch(patterns, input);
  if (!pattern) return null;
  return {
    action: "allow",
    rule: USER_ALLOW_RULE,
    reason: `allowed by your shell guard rule "${pattern.source}"`,
  };
}

function findMatch(
  patterns: readonly UserPattern[],
  input: NormalisedCommand,
): UserPattern | null {
  for (const pattern of patterns) {
    if (pattern.binary !== input.cmd) continue;
    if (argsMatch(pattern, input.args)) return pattern;
  }
  return null;
}

function argsMatch(
  pattern: UserPattern,
  args: readonly string[],
): boolean {
  if (args.length < pattern.argTokens.length) return false;
  if (!pattern.trailingGlob && args.length !== pattern.argTokens.length) {
    return false;
  }
  for (let i = 0; i < pattern.argTokens.length; i += 1) {
    if (!tokenMatches(pattern.argTokens[i] ?? "", args[i] ?? "")) return false;
  }
  return true;
}

/** Dull glob: `*` is any run of characters within this one argument. */
function tokenMatches(token: string, arg: string): boolean {
  const parts = token.split("*").map(escapeRegex);
  return new RegExp(`^${parts.join(".*")}$`).test(arg);
}

function escapeRegex(part: string): string {
  return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileAll(raw: readonly string[]): readonly UserPattern[] {
  const out: UserPattern[] = [];
  for (const entry of raw) {
    const tokens = entry.trim().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) continue;
    const rest = tokens.slice(1);
    const trailingGlob = rest[rest.length - 1] === "*";
    out.push({
      source: entry.trim(),
      // Same normalisation the guard applies to the command itself
      // (basename, lowercased), so `/usr/bin/GIT` in a pattern keys on
      // the same unit the verdict — and the shape grant — will.
      binary: basenameCommand(tokens[0] ?? "").toLowerCase(),
      argTokens: trailingGlob ? rest.slice(0, -1) : rest,
      trailingGlob,
    });
  }
  return out;
}
