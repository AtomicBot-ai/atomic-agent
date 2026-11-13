/**
 * A profile's `tools` list as a predicate over this agent's tool names.
 *
 * Three spellings are accepted, so a file written for Claude Code works:
 *  - our names, exactly (`os.fs.read`);
 *  - a prefix with `*` (`os.fs.*`, `mcp.github.*`);
 *  - Claude Code's tool names (`Read`, `Grep`, `Bash`, ...), mapped below.
 *    `mcp__server__tool` maps to `mcp.server.tool`, `mcp__server` to
 *    `mcp.server.*`.
 *
 * An entry that matches nothing we know is reported, not guessed at. A
 * list where nothing is recognised is NOT an empty allowlist: it is
 * dropped with a diagnostic and the worker keeps its default tools, since
 * hiding every tool would leave a worker that can only reply.
 *
 * The allowlist only ever narrows: it is ANDed with the worker's own
 * exclusions (`isWorkerVisibleTool`), so naming `fusion.delegate` or a
 * memory write here grants nothing.
 */

/** Tools every profile keeps: the turn's terminal and tool discovery. */
export const PROFILE_ALWAYS_ALLOWED: readonly string[] = ["reply", "tool.view", "tool.search"];

const CLAUDE_TOOL_NAMES: Readonly<Record<string, readonly string[]>> = {
  read: ["os.fs.read", "os.fs.read_document"],
  grep: ["os.fs.grep"],
  glob: ["os.fs.glob", "os.fs.list"],
  ls: ["os.fs.list"],
  bash: ["os.shell.run"],
  write: ["os.fs.write"],
  edit: ["os.fs.edit", "os.fs.patch"],
  multiedit: ["os.fs.edit", "os.fs.patch"],
  notebookedit: ["os.fs.edit"],
  webfetch: ["os.web.fetch"],
  websearch: ["os.web.search"],
};

/** Whether an entry looks like one of our names or patterns. */
function isOwnSpelling(entry: string): boolean {
  return /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*(\.\*)?$/.test(entry);
}

function translate(entry: string): string[] | null {
  const claude = CLAUDE_TOOL_NAMES[entry.toLowerCase()];
  if (claude !== undefined) return [...claude];
  const mcp = /^mcp__([A-Za-z0-9_-]+)(?:__([A-Za-z0-9_-]+))?$/.exec(entry);
  if (mcp !== null) {
    return [mcp[2] === undefined ? `mcp.${mcp[1]}.*` : `mcp.${mcp[1]}.${mcp[2]}`];
  }
  return isOwnSpelling(entry) ? [entry] : null;
}

export interface CompiledToolAllowlist {
  /** Absent: no usable allowlist, the worker keeps its default tools. */
  allows?: (name: string) => boolean;
  /** Entries we could not read, for the operator's diagnostics. */
  unknown: string[];
  /** What the entries turned into, for the delegate's `details`. */
  patterns: string[];
}

export function compileToolAllowlist(entries: readonly string[] | undefined): CompiledToolAllowlist {
  if (entries === undefined || entries.length === 0) return { unknown: [], patterns: [] };
  const patterns: string[] = [];
  const unknown: string[] = [];
  for (const entry of entries) {
    const translated = translate(entry);
    if (translated === null) unknown.push(entry);
    else for (const p of translated) if (!patterns.includes(p)) patterns.push(p);
  }
  if (patterns.length === 0) return { unknown, patterns };
  const exact = new Set([...PROFILE_ALWAYS_ALLOWED, ...patterns.filter((p) => !p.endsWith(".*"))]);
  const prefixes = patterns.filter((p) => p.endsWith(".*")).map((p) => p.slice(0, -1));
  return {
    allows: (name) => exact.has(name) || prefixes.some((prefix) => name.startsWith(prefix)),
    unknown,
    patterns,
  };
}
