import { getConfig } from "../../config/index.js";
import type { ToolDescriptor } from "../../prompt/stable-prefix.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../../prompt/tool-descriptors.js";
import { filterToolDescriptorsByConfig } from "../../runtime/filter-disabled-tools.js";

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
  ["git", "os.git"],
]);

/**
 * The slice of the app config that decides which built-in tools are
 * actually registered at runtime. Structurally satisfied by
 * `AtomicAgentConfig`, narrow enough for tests to construct by hand.
 */
export interface ToolGateSourceConfig {
  readonly browser: { readonly enabled: boolean };
  readonly web: { readonly search: { readonly enabled: boolean } };
  readonly vision: { readonly enabled: boolean };
  readonly memory: {
    readonly profile: { readonly enabled: boolean };
    readonly notes: { readonly enabled: boolean };
    readonly lessons: { readonly enabled: boolean };
    readonly procedures: { readonly enabled: boolean };
  };
  readonly tasks: {
    readonly enabled: boolean;
    readonly agentToolsEnabled: boolean;
  };
  readonly mcp: { readonly servers: readonly unknown[] };
}

/**
 * The catalog in `DEFAULT_TOOL_DESCRIPTORS` is static; the runtime
 * drops config-gated families before the model ever sees them (see
 * `bootstrap.ts` → `filterToolDescriptorsByConfig`). `/tools` must
 * apply the same gates or it advertises tools the agent cannot call
 * (e.g. `browser.*` under `browser.enabled=false`).
 *
 * Two gates are approximated because their runtime inputs are probed
 * at bootstrap, not read from config: vision uses `vision.enabled`
 * alone (the mmproj capability probe is not visible here), and the
 * MCP gate uses the configured server list instead of live
 * connections. Both approximations only ever err on the side of the
 * user's stated config.
 */
export function effectiveToolDescriptors(
  config: ToolGateSourceConfig = getConfig(),
): readonly ToolDescriptor[] {
  return filterToolDescriptorsByConfig(DEFAULT_TOOL_DESCRIPTORS, {
    browser: { enabled: config.browser.enabled },
    web: { search: { enabled: config.web.search.enabled } },
    vision: {
      enabled: config.vision.enabled,
      providerAvailable: config.vision.enabled,
    },
    memory: {
      profile: { enabled: config.memory.profile.enabled },
      notes: { enabled: config.memory.notes.enabled },
      lessons: { enabled: config.memory.lessons.enabled },
      procedures: { enabled: config.memory.procedures.enabled },
    },
    tasks: {
      agentToolsEnabled: config.tasks.enabled && config.tasks.agentToolsEnabled,
    },
    mcp: { enabled: config.mcp.servers.length > 0 },
  });
}

export interface ToolFamilyListing {
  readonly family: string;
  readonly tools: readonly string[];
}

/** Enabled built-in tools grouped by family, families and tools sorted. */
export function listToolFamilies(
  descriptors: readonly ToolDescriptor[] = effectiveToolDescriptors(),
): readonly ToolFamilyListing[] {
  const byFamily = new Map<string, string[]>();
  for (const descriptor of descriptors) {
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
export function searchTools(
  query: string,
  descriptors: readonly ToolDescriptor[] = effectiveToolDescriptors(),
): readonly string[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const needle = FAMILY_ALIASES.get(q) ?? q;
  return descriptors
    .map((d) => d.name)
    .filter((name) => name.toLowerCase().includes(needle))
    .sort((a, b) => a.localeCompare(b));
}

/** `/tools` with no argument: every enabled family, one line each. */
export function renderToolsOverview(
  descriptors: readonly ToolDescriptor[] = effectiveToolDescriptors(),
): string {
  const families = listToolFamilies(descriptors);
  const total = families.reduce((sum, f) => sum + f.tools.length, 0);
  const lines = [
    `built-in tools (${total}) enabled under the current config:`,
    "",
    ...families.map(renderFamilyLine),
    "",
    "these are separate from /skills, which lists optional playbooks.",
    "`/tools <query>` filters, e.g. `/tools filesystem` or `/tools browser`.",
  ];
  return lines.join("\n");
}

/** `/tools <query>`: matching tools, or a clear miss message. */
export function renderToolsSearch(
  query: string,
  descriptors: readonly ToolDescriptor[] = effectiveToolDescriptors(),
): string {
  const matches = searchTools(query, descriptors);
  if (matches.length === 0) {
    const gatedMatches = searchTools(query, DEFAULT_TOOL_DESCRIPTORS);
    if (gatedMatches.length > 0) {
      return [
        `no enabled tool matches "${query.trim()}". these exist but are turned off in your config:`,
        "",
        ...gatedMatches.map((name) => `  ${name}`),
      ].join("\n");
    }
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

/**
 * One overview line per family. Namespaced families show short member
 * names after the prefix; a single-segment tool (`reply`, `finish`)
 * IS its own family, so repeating the name would render "reply  reply".
 */
function renderFamilyLine(f: ToolFamilyListing): string {
  if (f.tools.length === 1 && f.tools[0] === f.family) {
    return `  ${f.family}`;
  }
  return `  ${f.family}  ${f.tools.map(shortName).join(" ")}`;
}

/** Drop the family prefix so the overview stays one line per family. */
function shortName(name: string): string {
  const lastDot = name.lastIndexOf(".");
  return lastDot === -1 ? name : name.slice(lastDot + 1);
}
