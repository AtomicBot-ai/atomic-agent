import { splitMcpToolName } from "../mcp/mcp-resource-class.js";
import {
  PREFIX_HEAD_SECTION,
  describePrefixSection,
  splitStablePrefixSections,
} from "./stable-prefix-sections.js";
import { estimateTokens } from "./token-budget.js";

/**
 * What one coarse prompt section is made of (ATO-2355).
 *
 * The context panel already says the stable prefix costs 9k. That number
 * is not actionable on its own: on a 32k window the operator needs to
 * know whether the 9k is the persona, the built-in tool catalog or one
 * MCP server with forty tools, because each has a different fix. These
 * parts are read off the text the builder actually assembled, split on
 * the same `### ` headers and `- <tool> — ` entry lines the prompt
 * carries, so nothing here is a guess about what the builder would do.
 */
export interface PromptPart {
  label: string;
  tokens: number;
  /** Set when the part is one MCP server's tool entries. */
  mcpServer?: string;
}

/** The row for every tool entry that is not an MCP server's. */
export const BUILTIN_TOOLS_PART = "built-in tools";

const TOOLS_SECTION = "tools";
const LOADED_TOOLS_HEADER = "### loaded-tools";
/** Same header shape `splitStablePrefixSections` splits on. */
const SECTION_HEADER = /^### [a-z][a-z0-9-]*$/;
/** `formatToolFrequent` / `formatToolRare` / `formatToolForLoadedTail`. */
const TOOL_ENTRY = /^- (\S+) — /;
const SEARCH_TOOL_ENTRY = /^- tool\.search — /m;

interface MeasuredText {
  label: string;
  text: string;
  mcpServer?: string;
}

/**
 * The stable prefix, one part per `### ` section. The tool catalog is
 * further split into built-in tools and one part per MCP server.
 *
 * Parts sum exactly to `total` (the figure the panel shows for the whole
 * prefix), so a breakdown never disagrees with the row it breaks down.
 */
export function stablePrefixParts(prefix: string, total: number): PromptPart[] {
  const measured: MeasuredText[] = [];
  for (const section of splitStablePrefixSections(prefix)) {
    const header =
      section.name === PREFIX_HEAD_SECTION ? "" : `### ${section.name}\n`;
    const text = `${header}${section.text}`;
    if (section.name === TOOLS_SECTION) {
      measured.push(...groupToolEntries(text));
      continue;
    }
    measured.push({ label: describePrefixSection(section.name), text });
  }
  return apportion(measured, total);
}

/**
 * The `### loaded-tools` block of the tail, split by MCP server. Empty
 * when the block is absent or holds only built-in tools: a breakdown
 * with one row restates its parent.
 */
export function loadedToolsParts(tail: string, total: number): PromptPart[] {
  const body = loadedToolsBody(tail);
  if (body === null) return [];
  const groups = groupToolEntries(body);
  if (!groups.some((g) => g.mcpServer !== undefined)) return [];
  return apportion(groups, total);
}

/** `tool.search` is in the catalog, i.e. search mode is on. */
export function prefixOffersToolSearch(prefix: string): boolean {
  return SEARCH_TOOL_ENTRY.test(prefix);
}

/**
 * The loaded-tools body. It follows the conversation, so the last match
 * is the real one: a transcript that quotes the header sits before it.
 */
function loadedToolsBody(tail: string): string | null {
  const marker = `\n${LOADED_TOOLS_HEADER}\n`;
  const at = tail.startsWith(`${LOADED_TOOLS_HEADER}\n`)
    ? 0
    : tail.lastIndexOf(marker);
  if (at < 0) return null;
  const start = at === 0 ? LOADED_TOOLS_HEADER.length + 1 : at + marker.length;
  const lines: string[] = [];
  for (const line of tail.slice(start).split("\n")) {
    if (SECTION_HEADER.test(line)) break;
    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Tool entry lines grouped by owner, in first-seen order with built-in
 * first. An entry runs from its `- <name> — ` line through the lines
 * that follow it; `# ` sub-headers and blank lines are catalog chrome
 * and count as built-in.
 */
function groupToolEntries(text: string): MeasuredText[] {
  const builtin: string[] = [];
  const servers = new Map<string, string[]>();
  let current = builtin;
  for (const line of text.split("\n")) {
    const entry = TOOL_ENTRY.exec(line);
    if (entry) {
      const server = splitMcpToolName(entry[1]!)?.server;
      if (server === undefined) {
        current = builtin;
      } else {
        current = servers.get(server) ?? [];
        servers.set(server, current);
      }
    } else if (line.trim() === "" || line.startsWith("#")) {
      current = builtin;
    }
    current.push(line);
  }
  const builtinText = builtin.join("\n");
  return [
    // Blank separator lines alone are catalog chrome, not a built-in part.
    { label: BUILTIN_TOOLS_PART, text: builtinText.trim() === "" ? "" : builtinText },
    ...[...servers].map(([server, lines]) => ({
      label: `mcp ${server}`,
      text: lines.join("\n"),
      mcpServer: server,
    })),
  ];
}

/**
 * Share `total` across the parts in proportion to their measured text,
 * by largest remainder so the integers add up to `total` exactly.
 * Estimating each part on its own rounds up once per part, so the raw
 * figures sum to a little more than the whole; scaling them keeps every
 * part's relative size and the parent row's number.
 */
function apportion(measured: readonly MeasuredText[], total: number): PromptPart[] {
  const raw = measured.map((m) => estimateTokens(m.text));
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum === 0 || total <= 0) return [];
  const exact = raw.map((r) => (r * total) / sum);
  const shares = exact.map(Math.floor);
  const left = total - shares.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, rest: value - shares[index]! }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (let k = 0; k < left; k += 1) {
    const slot = byRemainder[k % byRemainder.length]!.index;
    shares[slot] = shares[slot]! + 1;
  }
  const parts: PromptPart[] = [];
  measured.forEach((m, index) => {
    const tokens = shares[index]!;
    if (tokens <= 0) return;
    parts.push({
      label: m.label,
      tokens,
      ...(m.mcpServer !== undefined ? { mcpServer: m.mcpServer } : {}),
    });
  });
  return parts;
}
