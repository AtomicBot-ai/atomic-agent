import { compileToolAllowlist } from "../agent-profiles/profile-tools.js";

/**
 * `run --allowed-tools` / `--disallowed-tools` (ATO-2440) as the turn's
 * `RunTurnOptions.toolFilter`, the same seam `fusion.delegate` narrows a
 * worker with. A hidden tool leaves the prompt and the grammar, and a
 * call to it anyway is refused at dispatch (`batch-gates.ts`).
 *
 * The lists only narrow what the model can see. They approve nothing:
 * every tool that stays visible still goes through the approval gate at
 * dispatch, exactly as without the flags (Claude Code's `--tools` and
 * `--disallowedTools` narrow the same way; its `--allowedTools`, which
 * skips the prompt, has no counterpart here on purpose).
 *
 * Entries use the profile spellings (`profile-tools.ts`): our names
 * (`os.fs.read`), a prefix with `*` (`os.fs.*`, `mcp.github.*`), Claude
 * Code's names (`Read`, `Bash`, `mcp__github`). An entry we cannot read
 * is a usage error: a typo in a deny list must not quietly allow the tool.
 */

/** Never hidden: without them the turn cannot end with an answer. */
const ALWAYS_VISIBLE: ReadonlySet<string> = new Set(["reply", "finish"]);

export interface RunToolFilter {
  /** Absent when neither list was given. */
  filter?: (name: string) => boolean;
  /** Every pattern the two lists turned into, for the unmatched check. */
  patterns: string[];
}

function matcher(patterns: readonly string[]): (name: string) => boolean {
  const exact = new Set(patterns.filter((p) => !p.endsWith(".*")));
  const prefixes = patterns.filter((p) => p.endsWith(".*")).map((p) => p.slice(0, -1));
  return (name) => exact.has(name) || prefixes.some((prefix) => name.startsWith(prefix));
}

export function buildRunToolFilter(
  allowed: readonly string[],
  disallowed: readonly string[],
): RunToolFilter | { error: string } {
  if (allowed.length === 0 && disallowed.length === 0) return { patterns: [] };
  const allow = compileToolAllowlist(allowed);
  const deny = compileToolAllowlist(disallowed);
  const unknown = [...allow.unknown, ...deny.unknown];
  if (unknown.length > 0) {
    return {
      error: `unknown tool name: ${unknown.join(", ")} (use names like os.fs.read, a prefix like os.fs.*, or Read / Bash)`,
    };
  }
  const allows = allow.allows;
  const denies = matcher(deny.patterns);
  return {
    filter: (name) => {
      if (ALWAYS_VISIBLE.has(name)) return true;
      if (allows !== undefined && !allows(name)) return false;
      return !denies(name);
    },
    patterns: [...allow.patterns, ...deny.patterns],
  };
}

/**
 * The patterns that match no tool this runtime has, for a one-line
 * stderr warning. Not an error: an MCP server that is still connecting
 * has no tools yet.
 */
export function unmatchedToolPatterns(
  patterns: readonly string[],
  toolNames: readonly string[],
): string[] {
  return patterns.filter((pattern) => !toolNames.some(matcher([pattern])));
}
