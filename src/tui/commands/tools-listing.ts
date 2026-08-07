import { DEFAULT_TOOL_DESCRIPTORS } from "../../prompt/tool-descriptors.js";

/**
 * Human-readable grouping for `/tools`. Built-in tools are namespaced
 * (`os.fs.read`, `browser.navigate`, …), so the family is everything up
 * to the last dot; single-segment names fall back to themselves.
 */
function familyOf(name: string): string {
  const lastDot = name.lastIndexOf(".");
  return lastDot === -1 ? name : name.slice(0, lastDot);
}

/**
 * Names users search for, mapped to the family they actually live under.
 * `/skills` returning nothing for "filesystem" is what made a user
 * conclude the agent could not touch files at all (#71); the same
 * aliases let `/tools filesystem` answer instead of drawing a blank.
 */
const FAMILY_ALIASES: ReadonlyMap<string, string> = new Map([
  ["filesystem", "os.fs"],
  ["file", "os.fs"],
  ["files", "os.fs"],
  ["fs", "os.fs"],
  ["disk", "os.fs"],
  ["shell", "os.shell"],
  ["terminal", "os.shell"],
  ["bash", "os.shell"],
  ["web", "os.web"],
  ["http", "os.http"],
  ["net", "os.http"],
  ["network", "os.http"],
  ["browser", "browser"],
  ["chrome", "browser"],
  ["memory", "memory"],
  ["notes", "memory.notes"],
  ["vision", "vision"],
  ["image", "vision"],
  ["images", "vision"],
  ["git", "os.shell"],
]);

export interface ToolFamilyListing {
  readonly family: string;
  readonly tools: readonly string[];
}

/** All built-in tools grouped by family, families and tools sorted. */
export function listToolFamilies(): readonly ToolFamilyListing[] {
  const byFamily = new Map<string, string[]>();
  for (const descriptor of DEFAULT_TOOL_DESCRIPTORS) {
    const family = familyOf(descriptor.name);
    const bucket = byFamily.get(family);
    if (bucket) bucket.push(descriptor.name);
    else byFamily.set(family, [descriptor.name]);
  }
  return [...byFamily.entries()]
    .map(([family, tools]) => ({
      family,
      tools: [...tools].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.family.localeCompare(b.family));
}

/**
 * Resolve a user query to matching tools. Matches an alias
 * ("filesystem"), a family prefix ("os.fs"), or any substring of a tool
 * name. Returns an empty array when nothing matches.
 */
export function searchTools(query: string): readonly string[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const aliased = FAMILY_ALIASES.get(q);
  const needle = aliased ?? q;
  return DEFAULT_TOOL_DESCRIPTORS.map((d) => d.name)
    .filter((name) => name.toLowerCase().includes(needle.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
}

/** `/tools` with no argument: every family, one line each. */
export function renderToolsOverview(): string {
  const families = listToolFamilies();
  const total = families.reduce((sum, f) => sum + f.tools.length, 0);
  const lines = [
    `built-in tools (${total}) — always available, no install needed:`,
    "",
    ...families.map(
      (f) => `  ${f.family}  ${f.tools.map(shortName).join(" ")}`,
    ),
    "",
    "these are separate from /skills, which lists optional playbooks.",
    "`/tools <query>` filters, e.g. `/tools filesystem` or `/tools browser`.",
  ];
  return lines.join("\n");
}

/** `/tools <query>`: matching tools, or a clear miss message. */
export function renderToolsSearch(query: string): string {
  const matches = searchTools(query);
  if (matches.length === 0) {
    return (
      `no built-in tool matches "${query.trim()}".\n` +
      "run `/tools` for the full list, or `/skills` for optional skill packs."
    );
  }
  return [
    `built-in tools matching "${query.trim()}" (${matches.length}):`,
    "",
    ...matches.map((name) => `  ${name}`),
  ].join("\n");
}

/** Drop the family prefix so the overview stays one line per family. */
function shortName(name: string): string {
  const lastDot = name.lastIndexOf(".");
  return lastDot === -1 ? name : name.slice(lastDot + 1);
}
