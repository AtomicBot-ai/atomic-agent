/**
 * The admin policy turned into the answers each integration point needs.
 * Approval logic stays in `src/approval/`: the gate only receives a rule
 * match shaped like one of its saved rules.
 */
import type { ApprovalRule, RuleMatch } from "../approval/approval-rules.js";
import {
  describePolicyRule,
  evaluatePolicy,
  mcpServerVerdict,
  type EffectivePolicy,
  type McpServerVerdict,
  type PolicyVerdict,
} from "./policy-evaluator.js";
import { gateRequestTarget, toolCallTarget, type PolicyGateRequest, type PolicyTarget } from "./policy-targets.js";

function verdictFor(policy: EffectivePolicy, target: PolicyTarget | null): PolicyVerdict | null {
  if (target === null || policy.rules.length === 0) return null;
  return evaluatePolicy(policy, target.action, target.resources);
}

/**
 * For `ApprovalGate.setOrgPolicy`: a policy `deny` blocks the request and
 * an `ask` puts it to a person whatever the approval level, a session
 * grant or a saved allow rule says. A policy `allow` changes nothing: it
 * only cancels an earlier `ask` of the policy itself, it never skips a
 * prompt the user's own settings would show.
 */
export function policyRuleMatch(policy: EffectivePolicy, request: PolicyGateRequest): RuleMatch | null {
  const verdict = verdictFor(policy, gateRequestTarget(request));
  if (verdict === null || verdict.effect === "allow") return null;
  const rule: ApprovalRule = {
    id: `org-policy:${verdict.rule.source}:${verdict.rule.index + 1}`,
    decision: verdict.effect,
    tool: request.tool,
    createdAt: "",
    source: "user",
    note: describePolicyRule(verdict.rule),
  };
  return { decision: verdict.effect, rule };
}

/** The model-facing refusal for a tool call the policy denies, or null. */
export function policyCallRefusal(policy: EffectivePolicy, tool: string, args: unknown): string | null {
  const verdict = verdictFor(policy, toolCallTarget(tool, args));
  if (verdict?.effect !== "deny") return null;
  return (
    `${tool} was not run: blocked by your organization's policy (${describePolicyRule(verdict.rule)}).\n` +
    "This rule was set by an administrator, not a tool failure: do not retry the same call or " +
    "try another way to do the same thing; tell the user it is not allowed here."
  );
}

/** Why a skill may not be installed or loaded, or null when it may. */
export function skillPolicyRefusal(policy: EffectivePolicy, name: string): string | null {
  const verdict = verdictFor(policy, { action: "skill", resources: [name] });
  if (verdict?.effect !== "deny") return null;
  return `skill "${name}" is blocked by your organization's policy (${describePolicyRule(verdict.rule)})`;
}

/** The parts of an MCP server config the allowlist reads (structural, no MCP import). */
export interface PolicyMcpServerConfig {
  name: string;
  transport: { kind: string; command?: string; args?: string[]; url?: string };
}

/** For `McpManagerDeps.serverPolicy`: the allowlist verdict for one configured server. */
export function mcpServerPolicy(policy: EffectivePolicy, config: PolicyMcpServerConfig): McpServerVerdict {
  const t = config.transport;
  const command = t.command !== undefined ? [t.command, ...(t.args ?? [])].join(" ") : undefined;
  return mcpServerVerdict(policy, {
    name: config.name,
    ...(t.url !== undefined ? { url: t.url } : {}),
    ...(command !== undefined ? { command } : {}),
  });
}
