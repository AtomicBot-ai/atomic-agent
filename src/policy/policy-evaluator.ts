import { globMatches } from "./policy-glob.js";
import type { McpAllowlist, PolicyAction, PolicyEffect, PolicyRule } from "./policy-schema.js";

/** Where a piece of the effective policy came from, weakest first. */
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
}

export interface SourcedPolicyRule extends PolicyRule {
  source: PolicySourceKind;
  /** Position inside its own source, for messages (`system rule 3`). */
  index: number;
}

export interface EffectivePolicy {
  /** All rules in evaluation order: user file, then system file, then URL. */
  rules: SourcedPolicyRule[];
  /** From the strongest source that sets one; absent means every server is allowed. */
  mcpAllowlist?: McpAllowlist & { source: PolicySourceKind };
  sources: PolicySourceStatus[];
}

export const EMPTY_POLICY: EffectivePolicy = { rules: [], sources: [] };

export interface PolicyVerdict {
  effect: PolicyEffect;
  rule: SourcedPolicyRule;
  /** The resource the deciding rule matched. */
  resource: string;
}

const STRICTNESS: Record<PolicyEffect, number> = { allow: 0, ask: 1, deny: 2 };

/**
 * What the policy says about `action` on `resources`. For one resource
 * the last matching rule wins, except that any matching `deny` wins
 * outright. Over several resources (a compound shell line, a move with
 * two paths) the strictest answer wins. Null when no rule matches.
 */
export function evaluatePolicy(
  policy: EffectivePolicy,
  action: PolicyAction,
  resources: readonly string[],
): PolicyVerdict | null {
  let best: PolicyVerdict | null = null;
  for (const resource of resources) {
    const verdict = evaluateOne(policy.rules, action, resource);
    if (verdict === null) continue;
    if (verdict.effect === "deny") return verdict;
    if (best === null || STRICTNESS[verdict.effect] > STRICTNESS[best.effect]) best = verdict;
  }
  return best;
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

/** Whether the MCP allowlist lets `server` start. No allowlist allows everything. */
export function mcpServerVerdict(policy: EffectivePolicy, server: McpServerIdentity): McpServerVerdict {
  const list = policy.mcpAllowlist;
  if (list === undefined) return { allowed: true };
  const keys = [server.name, server.url, server.command].filter((k): k is string => typeof k === "string" && k.length > 0);
  if (list.servers.some((pattern) => keys.some((key) => globMatches(pattern, key)))) return { allowed: true };
  const message = `MCP server "${server.name}" is not on your organization's allowlist (${list.source} policy)`;
  return list.warnOnly ? { allowed: true, message: `${message}; allowed because the allowlist is in warn-only mode` } : { allowed: false, message };
}
