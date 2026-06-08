import { basenameCommand } from "../normalise.js";
import type { Rule } from "../guard-types.js";

/**
 * `ddgr` is a read-only DuckDuckGo search CLI. It has no capability to
 * mutate local or remote state — every invocation only fetches search
 * results — so it bypasses the approval gate entirely (same reasoning as
 * the `icalbuddy` reader). Dangerous / hardline patterns still run first
 * in `DEFAULT_RULES`, so an obfuscated payload smuggled through ddgr args
 * is caught before this rule is consulted.
 */
export const ddgrReadOnlyRule: Rule = {
  id: "ddgr.read_only",
  layer: "trusted",
  match(input) {
    if (input.cmd !== "ddgr") return null;
    return {
      action: "allow",
      rule: "ddgr.read_only",
      reason: "ddgr read-only web search",
    };
  },
};

export function isDdgrCommand(cmd: string): boolean {
  return basenameCommand(cmd).normalize("NFKC").toLowerCase() === "ddgr";
}
