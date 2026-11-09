import type { ToolDescriptor } from "../../prompt/stable-prefix.js";

/**
 * When the tool catalog is described on demand (ATO-558).
 *
 * A 4–9B model on a 32K window cannot afford ~90 built-in schemas plus
 * whatever MCP servers add: the `### tools` block alone eats the room it
 * needs to think, and a long list of near-identical schemas is where
 * small models pick the wrong tool. In search mode the CORE set below
 * keeps its full description, every other tool drops to a one-line entry
 * under `# extras`, and `tool.search` finds the right one by words and
 * loads its schema.
 *
 * The earlier attempt at this for MCP tools ("catalog + tool.view") was
 * rolled back because small models rarely took the extra `tool.view`
 * step (see `mcp-descriptor-builder.ts`). Two things differ here: the
 * core set — what most turns need — never leaves the prompt, and a
 * search answers with the ready-to-copy call, not only a schema, so the
 * next step is the call itself.
 */
export type ToolSearchMode = "auto" | "on" | "off";

export const TOOL_SEARCH_MODES: readonly ToolSearchMode[] = ["auto", "on", "off"];

/** `auto` defers the catalog at or below this context window (tokens). */
export const TOOL_SEARCH_SMALL_WINDOW = 32_768;

/** `auto` defers the catalog when it holds more descriptors than this. */
export const TOOL_SEARCH_MAX_TOOLS = 100;

/** Summary length of a deferred tool's one-line `# extras` entry. */
export const DEFERRED_SUMMARY_CHARS = 100;

export const TOOL_SEARCH_NAME = "tool.search";

/**
 * Tools that stay fully described in search mode: the terminals, the
 * discovery tools, files, the shell, the web reads, memory, the checks,
 * the fan-out and the core browser moves. A name that is not in this
 * build (or gated off) is simply never a descriptor.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "reply",
  "finish",
  "tool.view",
  TOOL_SEARCH_NAME,
  "skill.view",
  "os.shell.run",
  "os.fs.read",
  "os.fs.write",
  "os.fs.edit",
  "os.fs.patch",
  "os.fs.list",
  "os.fs.glob",
  "os.fs.grep",
  "os.fs.code_map",
  "os.fs.locate_project",
  "os.fs.move",
  "os.fs.trash",
  "os.fs.read_document",
  "os.web.search",
  "os.web.fetch",
  "memory.notes.store",
  "memory.notes.recall",
  "memory.profile.set",
  "verify.syntax",
  "verify.run",
  "fusion.delegate",
  "vision.describe",
  "browser.navigate",
  "browser.read_aria",
  "browser.click",
  "browser.type",
]);

/**
 * Is search mode on for this catalog and window? `on`/`off` are what
 * they say; `auto` turns it on for a small window or a big catalog.
 * An unknown window counts as not small.
 */
export function toolSearchActive(
  mode: ToolSearchMode,
  toolCount: number,
  contextWindow: number | null | undefined,
): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  if (toolCount > TOOL_SEARCH_MAX_TOOLS) return true;
  return typeof contextWindow === "number" && contextWindow > 0 && contextWindow <= TOOL_SEARCH_SMALL_WINDOW;
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The descriptor list the prompt describes. Inactive: unchanged, minus
 * `tool.search` (nothing is deferred, so there is nothing to find).
 * Active: core tools as they are, every other tool `rare` with a short
 * summary — its full descriptor stays in the list `tool.search` reads.
 */
export function applyToolSearch(
  descriptors: readonly ToolDescriptor[],
  active: boolean,
): readonly ToolDescriptor[] {
  if (!active) {
    return descriptors.some((d) => d.name === TOOL_SEARCH_NAME)
      ? descriptors.filter((d) => d.name !== TOOL_SEARCH_NAME)
      : descriptors;
  }
  return descriptors.map((d) => {
    if (CORE_TOOL_NAMES.has(d.name)) return d;
    const summary = shorten(d.summary, DEFERRED_SUMMARY_CHARS);
    if (d.tier === "rare" && summary === d.summary) return d;
    return { ...d, tier: "rare" as const, summary };
  });
}

/** Names `applyToolSearch` deferred: rare now, not rare in the full list. */
export function deferredToolNames(
  full: readonly ToolDescriptor[],
  effective: readonly ToolDescriptor[],
): ReadonlySet<string> {
  const before = new Map(full.map((d) => [d.name, d.tier ?? "frequent"] as const));
  const out = new Set<string>();
  for (const d of effective) {
    if (d.tier === "rare" && before.get(d.name) !== "rare") out.add(d.name);
  }
  return out;
}
