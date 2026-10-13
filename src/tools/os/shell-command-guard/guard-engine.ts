import type {
  GuardInput,
  GuardVerdict,
  Rule,
  ShellGuardPolicy,
} from "./guard-types.js";
import { normaliseCommand } from "./normalise.js";
import { hardlineRule } from "./rules-hardline.js";
import { buildGitRemotePolicyRule } from "./rules-policy.js";
import { dangerousRule } from "./rules-dangerous.js";
import { gogReadOnlyRule } from "./rules-trusted/gog.js";
import { ghReadOnlyRule } from "./rules-trusted/gh.js";
import { icalBuddyReadOnlyRule } from "./rules-trusted/ical-buddy.js";
import { buildUserGuardRules } from "./rules-user.js";
import { safeAllowRule } from "./rules-safe-allow.js";

/** The trusted read-only allows, in evaluation order. */
const TRUSTED_RULES: readonly Rule[] = [
  gogReadOnlyRule,
  ghReadOnlyRule,
  icalBuddyReadOnlyRule,
];

/** Everything after the hardline layer, in evaluation order. */
const RULES_AFTER_HARDLINE: readonly Rule[] = [
  dangerousRule,
  ...TRUSTED_RULES,
  safeAllowRule,
];

const DEFAULT_RULES: readonly Rule[] = [hardlineRule, ...RULES_AFTER_HARDLINE];

/**
 * Evaluate the default rule set. A `policy` (injected by the bootstrap,
 * absent in unit tests and embedders that have no config) adds the
 * operator-policy layer right after the hardline rules, so a policy
 * refusal can never be shadowed by a trusted or safe-allow match, and
 * the user's own guard rules (`shellGuard.*` in config.json, issue
 * #229) between the trusted read-only allows and safe-allow. That
 * placement is the property the issue thread settled on: the user layer
 * is consulted only after the built-in dangerous decisions have had
 * their say, so a pattern can displace what safe-allow or the default
 * fallthrough would do (narrow what prompts) but can never silence a
 * dangerous or hardline verdict — not "must not", *cannot*.
 */
export function checkShellCommandGuard(
  input: GuardInput,
  policy?: ShellGuardPolicy,
): GuardVerdict {
  if (!policy) {
    return checkShellCommandGuardWithRules(input, DEFAULT_RULES);
  }
  const rules: readonly Rule[] = [
    hardlineRule,
    buildGitRemotePolicyRule(policy),
    dangerousRule,
    ...TRUSTED_RULES,
    ...buildUserGuardRules(policy.userGuardRules?.()),
    safeAllowRule,
  ];
  return checkShellCommandGuardWithRules(input, rules);
}

export function checkShellCommandGuardWithRules(
  input: GuardInput,
  rules: readonly Rule[],
): GuardVerdict {
  const normalised = normaliseSafely(input);
  if (normalised.status === "error") return normalised.verdict;

  for (const rule of rules) {
    try {
      const verdict = rule.match(normalised.command, input);
      if (verdict !== null) return verdict;
    } catch {
      return {
        action: "approval_required",
        rule: `${rule.id}.error`,
        reason: `rule ${rule.id} threw (fail-closed)`,
      };
    }
  }

  return {
    action: "approval_required",
    rule: "default",
    reason: "no shell guard rule matched; approval required",
  };
}

function normaliseSafely(
  input: GuardInput,
):
  | { status: "ok"; command: ReturnType<typeof normaliseCommand> }
  | { status: "error"; verdict: GuardVerdict } {
  try {
    return { status: "ok", command: normaliseCommand(input) };
  } catch {
    return {
      status: "error",
      verdict: {
        action: "approval_required",
        rule: "guard.normalise_failed",
        reason: "shell guard normalisation failed (fail-closed)",
      },
    };
  }
}
