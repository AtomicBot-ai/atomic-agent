/**
 * `frequent` — full `args` + optional `examples` in the stable prefix.
 * `rare` — one-line manifest in the prefix; use `tool.view` (or error-path
 * autoload) to materialise the full schema in `### loaded-tools`.
 */
export type ToolTier = "frequent" | "rare";

export interface ToolDescriptor {
  name: string;
  summary: string;
  argsSchema: string;
  /** Defaults to `frequent` when omitted. */
  tier?: ToolTier;
  /**
   * Optional few-shot argument examples rendered under the tool in the
   * stable prefix. Each entry is a pre-formatted JSON literal (as a
   * string) so we do not stringify at prompt-build time. Keep short —
   * they live in the stable prefix and cost tokens on every turn.
   */
  examples?: readonly string[];
}

export interface CapabilitiesSummary {
  platform: NodeJS.Platform;
  arch: string;
  browserChannel: string;
  workingDir: string;
  hasClipboard: boolean;
  hasWmctrl: boolean;
  hasNotifications: boolean;
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  source: "global" | "project";
}

export interface StablePrefixInput {
  toolDescriptors: readonly ToolDescriptor[];
  capabilities: CapabilitiesSummary;
  skillCatalog: readonly SkillCatalogEntry[];
  systemPersona?: string;
  reasoningSystemToken?: string;
}

/**
 * The stable prefix is the part of the prompt that must stay byte-stable
 * within a session so llama.cpp can reuse its KV-cache. Order and spacing
 * are intentional — changing any byte invalidates the slot.
 */
export const DEFAULT_SYSTEM_PERSONA = [
  "You are atomic-agent, a local operator. Each step is exactly one JSON object matching the tool grammar — no other prose.",
  "Terminals: `reply` returns the final answer to the user and ends the current macro-turn (session stays open). `finish` ends the entire session; only with explicit user intent.",
  "`reply` is ONLY for the final user-facing text after all needed tools ran. The user does not see intermediate text — if another tool is next, emit that tool JSON, not `reply`.",
  "Loop: call tools, read `### world` / `### conversation`, then more tools or `reply`. `browser.navigate` and `browser.search` refresh the world; avoid redundant `read_aria`. Match a skill? `skill.view` first. Rare tool? `tool.view` first. Do not invent facts — use `reply` to ask if stuck.",
  "Deleting files or directories: when the user asks to delete, remove, erase, or trash paths, call `os.fs.trash` with concrete absolute paths in `paths` (use `os.fs.list` / `os.fs.glob` first if you need to discover names). Do not use `os.shell.run` with `rm`, `unlink`, or `rmdir` for that unless the user explicitly demands permanent irreversible shell deletion.",
  "Memory: persist with `memory.profile.*` and `memory.notes.*` as needed. Use `### recalled` / `### memory-index` and `memory.notes.recall` for past context. Store distilled facts, not full dumps. `### notice` in the tail is a hard nudge to change strategy.",
].join("\n");

export function buildStablePrefix(input: StablePrefixInput): string {
  const persona = input.systemPersona ?? DEFAULT_SYSTEM_PERSONA;
  const frequent: ToolDescriptor[] = [];
  const rare: ToolDescriptor[] = [];
  for (const d of input.toolDescriptors) {
    if (d.tier === "rare") rare.push(d);
    else frequent.push(d);
  }
  const commonBlock = frequent.map(formatToolFrequent).join("\n");
  const extrasBlock = rare.map(formatToolRare).join("\n");
  const caps = formatCapabilities(input.capabilities);
  const skills =
    input.skillCatalog.length > 0
      ? input.skillCatalog.map(formatSkillEntry).join("\n")
      : "(none installed)";
  return [
    `### system`,
    ...(input.reasoningSystemToken ? [input.reasoningSystemToken.trimEnd()] : []),
    persona,
    ``,
    `### rules`,
    `One tool JSON per step. Destructive or privileged tools may require user approval. Summaries in \`# extras\` list rare tools; call \`tool.view\` to load the full \`args\` schema into \`### loaded-tools\` before use.`,
    ``,
    `### tools`,
    `# common (full)`,
    commonBlock,
    ``,
    `# extras (one-line; use \`tool.view\` { name: "<tool>" } for full schema)`,
    extrasBlock,
    ``,
    `### capabilities`,
    caps,
    ``,
    `### skills`,
    skills,
    ``,
    `### instructions`,
    `Emit one JSON tool call now. Use \`reply\` for natural-language answers to the user.`,
    ``,
  ].join("\n");
}

/**
 * Renders a frequent tool for the stable prefix: summary + `args` + optional examples.
 */
export function formatToolFrequent(descriptor: ToolDescriptor): string {
  const head = `- ${descriptor.name} — ${descriptor.summary}\n  args: ${descriptor.argsSchema}`;
  if (!descriptor.examples || descriptor.examples.length === 0) {
    return head;
  }
  const examples = descriptor.examples
    .map((ex) => `    - ${ex}`)
    .join("\n");
  return `${head}\n  examples:\n${examples}`;
}

/** Renders a rare tool as a single-line manifest (no `args` in the prefix). */
function formatToolRare(descriptor: ToolDescriptor): string {
  return `- ${descriptor.name} — ${descriptor.summary}`;
}

/**
 * Renders a loaded tool block for the variable tail (`### loaded-tools`).
 * Uses the same shape as `formatToolFrequent` without `examples` if absent.
 */
export function formatToolForLoadedTail(
  name: string,
  summary: string,
  argsSchema: string,
  examples?: readonly string[],
): string {
  const head = `- ${name} — ${summary}\n  args: ${argsSchema}`;
  if (!examples || examples.length === 0) return head;
  const ex = examples.map((e) => `    - ${e}`).join("\n");
  return `${head}\n  examples:\n${ex}`;
}

function formatCapabilities(caps: CapabilitiesSummary): string {
  return [
    `platform: ${caps.platform}/${caps.arch}`,
    `browser: ${caps.browserChannel}`,
    `working_dir: ${caps.workingDir}`,
    `clipboard: ${caps.hasClipboard ? "yes" : "no"}`,
    `wmctrl: ${caps.hasWmctrl ? "yes" : "no"}`,
    `notifications: ${caps.hasNotifications ? "yes" : "no"}`,
  ].join("\n");
}

function formatSkillEntry(entry: SkillCatalogEntry): string {
  const tag = entry.source === "project" ? "[project]" : "[global]";
  return `- ${tag} ${entry.name}: ${entry.description}`;
}
