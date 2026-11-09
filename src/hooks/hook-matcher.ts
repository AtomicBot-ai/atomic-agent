import { MCP_TOOL_PREFIX } from "../mcp/mcp-resource-class.js";

/**
 * Claude Code tool names for our tools, so a hook written for Claude
 * (`"matcher": "Bash"`, `"Edit|Write"`) matches the same action here.
 * Several of ours map to one Claude name where Claude has a single tool.
 */
const CLAUDE_ALIASES: Readonly<Record<string, string>> = {
  "os.shell.run": "Bash",
  "os.fs.read": "Read",
  "os.fs.read_document": "Read",
  "os.fs.write": "Write",
  "os.fs.edit": "Edit",
  "os.fs.patch": "MultiEdit",
  "os.fs.glob": "Glob",
  "os.fs.grep": "Grep",
  "os.fs.list": "LS",
  "os.web.fetch": "WebFetch",
  "os.web.search": "WebSearch",
  "fusion.delegate": "Task",
};

/**
 * Extra Claude names a matcher may use for one of our tools: Claude's
 * `Edit` covers what our `os.fs.patch` does, so `Edit` matches it too.
 */
const EXTRA_MATCH_NAMES: Readonly<Record<string, readonly string[]>> = {
  "os.fs.patch": ["Edit"],
};

/**
 * The Claude Code name for one of our tools, or `null` when Claude has no
 * equivalent. MCP tools map `mcp.<server>.<tool>` to `mcp__<server>__<tool>`.
 */
export function claudeToolName(tool: string): string | null {
  const alias = CLAUDE_ALIASES[tool];
  if (alias !== undefined) return alias;
  // `mcp.resource.*` / `mcp.prompt.*` are our own discovery tools, not a server's.
  if (tool.startsWith(MCP_TOOL_PREFIX) && !/^mcp\.(?:resource|prompt)\./.test(tool)) {
    const rest = tool.slice(MCP_TOOL_PREFIX.length);
    const dot = rest.indexOf(".");
    if (dot > 0 && dot < rest.length - 1) {
      return `mcp__${rest.slice(0, dot)}__${rest.slice(dot + 1)}`;
    }
  }
  return null;
}

/** Every name a matcher is tested against: ours, the Claude alias, extras. */
export function matchNamesFor(tool: string): string[] {
  const names = [tool];
  const alias = claudeToolName(tool);
  if (alias !== null) names.push(alias);
  for (const extra of EXTRA_MATCH_NAMES[tool] ?? []) names.push(extra);
  return names;
}

const regexCache = new Map<string, RegExp | null>();

function compile(matcher: string): RegExp | null {
  if (regexCache.has(matcher)) return regexCache.get(matcher)!;
  let re: RegExp | null;
  try {
    re = new RegExp(`^(?:${matcher})$`);
  } catch {
    re = null;
  }
  regexCache.set(matcher, re);
  return re;
}

/** True when `matcher` is a pattern this module can compile (or empty). */
export function isValidMatcher(matcher: string): boolean {
  return matcher === "" || matcher === "*" || compile(matcher) !== null;
}

/**
 * Does a matcher select this tool? Empty and `*` match everything. A
 * matcher is a regular expression tested against the whole name (anchored),
 * so `Edit|Write` matches exactly those two and `mcp__github__.*` every tool
 * of that server. One that does not compile is compared as plain text.
 */
export function matcherMatches(matcher: string, tool: string): boolean {
  if (matcher === "" || matcher === "*") return true;
  const re = compile(matcher);
  const names = matchNamesFor(tool);
  if (re === null) return names.includes(matcher);
  return names.some((name) => re.test(name));
}
