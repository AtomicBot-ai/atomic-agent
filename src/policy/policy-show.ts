import { describePolicyRule, type EffectivePolicy } from "./policy-evaluator.js";

/** Plain-text report of the effective policy and where each part came from. */
export function formatPolicy(policy: EffectivePolicy): string {
  const lines: string[] = ["Sources (each can only tighten; the strictest answer across them wins):"];
  for (const s of policy.sources) {
    let line = `  ${s.kind.padEnd(6)} ${s.state.padEnd(11)} ${s.location}`;
    if (s.namedBy) line += s.namedBy === "system" ? " [named by the machine-wide file]" : ` [from ATOMIC_POLICY_URL]`;
    if (s.fetchedAt) line += ` (fetched ${s.fetchedAt})`;
    if (s.error) line += `: ${s.error}`;
    lines.push(line);
  }
  lines.push("");
  if (policy.rules.length === 0) {
    lines.push("Rules: none");
  } else {
    lines.push("Rules (per source the last match wins; across sources the strictest wins; any deny wins):");
    for (const rule of policy.rules) lines.push(`  ${describePolicyRule(rule)}`);
  }
  lines.push("");
  const lists = policy.mcpAllowlists;
  if (lists.length === 0) lines.push("MCP allowlist: none (every configured server may start)");
  else if (lists.length > 1) lines.push("MCP allowlists (a server must be on each one):");
  for (const list of lists) {
    const mode = list.warnOnly ? "warn only" : "enforced";
    lines.push(`MCP allowlist (${list.source} policy, ${mode}):`);
    if (list.servers.length === 0) lines.push("  (empty: no server may start)");
    for (const server of list.servers) lines.push(`  ${server}`);
  }
  return `${lines.join("\n")}\n`;
}
