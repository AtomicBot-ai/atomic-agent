import { globMatches } from "./policy-glob.js";
import type { McpAllowlist, PolicyAction, PolicyEffect, PolicyRule } from "./policy-schema.js";

/** Where a piece of the effective policy came from. No source can loosen another. */
export type PolicySourceKind = "user" | "system" | "url";

export interface PolicySourceStatus {
  kind: PolicySourceKind;
  /** File path, or the URL for `url`. */
  location: string;
  /**
   * `loaded`: read now. `cached`: the URL could not be fetched and the
   * last good copy was used. `missing`: no file / no URL set.
   * `invalid`: present but unreadable or malformed, so ignored.
   * `unreachable`: the URL failed and there is no cached copy.
   */
  state: "loaded" | "cached" | "missing" | "invalid" | "unreachable";
  error?: string;
  /** For `url`: when the copy in use was fetched. */
  fetchedAt?: string;
  /** For `url`: whether the machine-wide file or `ATOMIC_POLICY_URL` named it. */
  namedBy?: "system" | "env";
}

export interface SourcedPolicyRule extends PolicyRule {
  source: PolicySourceKind;
  /** Position inside its own source, for messages (`system rule 3`). */
  index: number;
}

export interface EffectivePolicy {
  /** All rules, grouped by source: user file, then system file, then URL. */
  rules: SourcedPolicyRule[];
  /** Every source's allowlist; a server must pass each one. Empty means every server is allowed. */
  mcpAllowlists: Array<McpAllowlist & { source: PolicySourceKind }>;
  sources: PolicySourceStatus[];
}

export const EMPTY_POLICY: EffectivePolicy = { rules: [], mcpAllowlists: [], sources: [] };

export interface PolicyVerdict {
  effect: PolicyEffect;
  rule: SourcedPolicyRule;
  /** The resource the deciding rule matched. */
  resource: string;
}

const STRICTNESS: Record<PolicyEffect, number> = { allow: 0, ask: 1, deny: 2 };

/**
 * What the policy says about `action` on `resources`. Inside one source
 * the last matching rule wins, except that any matching `deny` wins
 * outright. Across sources, and over several resources (a compound shell
 * line, a move with two paths), the strictest answer wins: an `allow` in
 * one source never cancels another source's `ask`, so a source the user
 * can write (their own file, `ATOMIC_POLICY_URL`, the cache) can only
 * tighten. With `unreadable` (a script piped into a shell) every `deny`
 * and `ask` of the action matches. Null when no rule matches.
 */
export function evaluatePolicy(
  policy: EffectivePolicy,
  action: PolicyAction,
  resources: readonly string[],
  options: { unreadable?: boolean } = {},
): PolicyVerdict | null {
  const groups = rulesBySource(policy.rules);
  let best: PolicyVerdict | null = null;
  // A script no one can read could be the very command a deny or ask
  // names, so every such rule of the action matches it.
  if (options.unreadable === true) {
    for (const rule of policy.rules) {
      if (rule.action !== action || rule.effect === "allow") continue;
      const verdict: PolicyVerdict = { effect: rule.effect, rule, resource: resources[0] ?? "" };
      if (verdict.effect === "deny") return verdict;
      best ??= verdict;
    }
  }
  for (const resource of resources) {
    for (const rules of groups) {
      const verdict = evaluateOne(rules, action, resource);
      if (verdict === null) continue;
      if (verdict.effect === "deny") return verdict;
      if (best === null || STRICTNESS[verdict.effect] > STRICTNESS[best.effect]) best = verdict;
    }
  }
  return best;
}

function rulesBySource(rules: readonly SourcedPolicyRule[]): SourcedPolicyRule[][] {
  const groups = new Map<PolicySourceKind, SourcedPolicyRule[]>();
  for (const rule of rules) {
    const group = groups.get(rule.source);
    if (group === undefined) groups.set(rule.source, [rule]);
    else group.push(rule);
  }
  return [...groups.values()];
}

function evaluateOne(
  rules: readonly SourcedPolicyRule[],
  action: PolicyAction,
  resource: string,
): PolicyVerdict | null {
  let last: SourcedPolicyRule | null = null;
  for (const rule of rules) {
    if (rule.action !== action || !globMatches(rule.resource, resource)) continue;
    if (rule.effect === "deny") return { effect: "deny", rule, resource };
    last = rule;
  }
  return last === null ? null : { effect: last.effect, rule: last, resource };
}

/** One line naming a rule, for a refusal or `policy show`. */
export function describePolicyRule(rule: SourcedPolicyRule): string {
  const base = `${rule.source} policy rule ${rule.index + 1}: ${rule.effect} ${rule.action} "${rule.resource}"`;
  return rule.note ? `${base} (${rule.note})` : base;
}

export interface McpServerIdentity {
  name: string;
  url?: string;
  command?: string;
}

export interface McpServerVerdict {
  allowed: boolean;
  /** Set when the server is not listed: the refusal, or the warning in `warnOnly` mode. */
  message?: string;
}

/**
 * Whether the MCP allowlists let `server` start: it must be on every
 * source's list (so no source can widen another's). A list in `warnOnly`
 * mode only warns. No allowlist allows everything.
 */
export function mcpServerVerdict(policy: EffectivePolicy, server: McpServerIdentity): McpServerVerdict {
  const keys = [server.name, server.url, server.command].filter((k): k is string => typeof k === "string" && k.length > 0);
  const missing = policy.mcpAllowlists.filter(
    (list) => !list.servers.some((pattern) => keys.some((key) => globMatches(pattern, key))),
  );
  if (missing.length === 0) return { allowed: true };
  const enforced = missing.find((list) => !list.warnOnly);
  const list = enforced ?? missing[0]!;
  const message = `MCP server "${server.name}" is not on your organization's allowlist (${list.source} policy)`;
  return enforced === undefined
    ? { allowed: true, message: `${message}; allowed because the allowlist is in warn-only mode` }
    : { allowed: false, message };
}
