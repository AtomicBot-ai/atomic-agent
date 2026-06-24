import { formatSkillCatalogLine } from "../skills/skill-catalog.js";

/**
 * `frequent` — full `args` + optional `examples` in the stable prefix.
 * `rare` — one-line manifest in the prefix; use `tool.view` (or error-path
 * autoload) to materialise the full schema in `### loaded-tools`.
 */
export type ToolTier = "frequent" | "rare";

export interface ToolDescriptor {
  name: string;
  summary: string;
  /**
   * Human-readable args sketch rendered into the stable prefix's
   * `### tools` section and consumed by the GBNF + parser path. Stays
   * authoritative for prompt rendering even when `argsJsonSchema` is
   * also populated — the LLM reads it as part of the prompt.
   */
  argsSchema: string;
  /**
   * Defaults to `frequent` when omitted.
   */
  tier?: ToolTier;
  /**
   * Optional few-shot argument examples rendered under the tool in the
   * stable prefix. Each entry is a pre-formatted JSON literal (as a
   * string) so we do not stringify at prompt-build time. Keep short —
   * they live in the stable prefix and cost tokens on every turn.
   */
  examples?: readonly string[];
  /**
   * Optional structured JSON Schema for the tool's `args` object. Used
   * exclusively by the cloud `native_tools` transport (OpenAI / OpenRouter
   * `tool_calls`) to constrain the model's argument shape. When omitted
   * the OpenAI adapter falls back to `{ type: "object",
   * additionalProperties: true }` — i.e. anything goes, which is what we
   * shipped before Memory-v2 phase 7b. Local llama-server with GBNF does
   * **not** consume this field; the grammar there already constrains the
   * shape and the prompt-side `argsSchema` text is what the model reads.
   *
   * For MCP-namespaced tools this field carries the server's
   * `inputSchema` verbatim (see `mcp-descriptor-builder.ts`).
   */
  argsJsonSchema?: Record<string, unknown>;
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
  /**
   * When set, the stable prefix opens with this native turn token (e.g.
   * `"<|turn>system\n"`) and the `reasoningSystemToken` is placed at the
   * very top of the system turn (before `### system`) — required by Gemma 4
   * to activate its reasoning channel. When omitted, the prefix keeps the
   * legacy monolithic head (`### system` first) and is byte-identical.
   */
  turnSystemOpen?: string;
  maxParallelToolCalls?: number;
}

/**
 * The stable prefix is the part of the prompt that must stay byte-stable
 * within a session so llama.cpp can reuse its KV-cache. Order and spacing
 * are intentional — changing any byte invalidates the slot.
 */
export const DEFAULT_SYSTEM_PERSONA = [
  "You are atomic-agent, a local operator. Each step emits exactly one JSON array matching the tool grammar — no other prose.",
  "Bias toward action: keep planning minimal; unless the user explicitly asked for analysis or explanation only, choose the next tool-call array quickly instead of long deliberation. If the template forces a separate reasoning or thinking block before JSON, keep that block to a few words (or effectively empty), then emit the array.",
  "Terminals: `reply` returns the final answer to the user and ends the current macro-turn (session stays open). `finish` ends the entire session; only with explicit user intent.",
  "`reply` is ONLY for the final user-facing text after all needed tools ran. The user does not see intermediate text — if another tool is next, emit that tool JSON, not `reply`.",
  "Output discipline: when the request specifies an exact answer format, length, or units, follow it precisely — give exactly what was asked in that shape (correct units, no restating the question, no extra commentary or markdown the format does not call for). When no format is specified, answer as fully and helpfully as the task warrants.",
  "Finishing the job: when the user asks you to build, run, compute, or verify something, the deliverable is a real result backed by actual tool output — not a description of one. Do not stop after a stub, a plan, or a single command; keep calling tools until you have actually produced the requested result, then `reply` with what real execution returned. If a tool, install, or network call fails and blocks the real path, say so directly and try an alternative (a different approach, or `reply` to ask the user). NEVER substitute plausible-looking fabricated output (made-up data, invented file contents, synthesised API responses) for results you could not actually produce — reporting a blocker honestly is always better than inventing a result.",
  "When a line in `### skills` matches the user's request, emit `skill.view` first — the catalog line is a stub, the body has the actual procedure — unless that skill is already under `### loaded-skills`. This applies to every skill, including text-only workflows; do not guess the answer from the catalog summary. Rare tool? `tool.view` first. Loop: tools, read `### world` / `### conversation`, then more tools or `reply`. `browser.navigate` / `browser.search` refresh the world; avoid redundant `read_aria`. Do not invent facts — use `reply` to ask if stuck.",
  "Web — READ THIS BEFORE ANY WEB ACTION. DEFAULT and ALWAYS-FIRST path: use `os.web.search` to search the web and `os.web.fetch` to read ANY page (clean markdown, no browser). The `browser.*` tools are a LAST RESORT, not the default: use them ONLY when (a) the user explicitly says to use the browser, or (b) the page genuinely needs JS/login/clicks that `os.web.fetch` cannot deliver. Opening `browser.navigate` / `browser.search` just to read a page or run a search is WRONG — it wastes the turn and bloats context. If you catch yourself reaching for the browser, stop and use `os.web.search` or `os.web.fetch` instead.",
  "Large directories: `os.fs.list` only shows up to maxEntries matches—use extensions, pattern, sort, or `os.fs.glob` to narrow before assuming a file type is absent. For many PDFs or resumes prefer filename `os.fs.glob` patterns plus `os.fs.read_document` on a short candidate list; avoid sweeping `os.fs.grep` with `glob` over huge `*.pdf` trees.",
  "Deleting files or directories: when the user asks to delete, remove, erase, or trash paths, call `os.fs.trash` with concrete absolute paths in `paths` (use `os.fs.list` / `os.fs.glob` first if you need to discover names). Do not use `os.shell.run` with `rm`, `unlink`, or `rmdir` for that unless the user explicitly demands permanent irreversible shell deletion.",
  "Memory: persist with `memory.profile.*` and `memory.notes.*` as needed. Use `### lessons` (pointer view of distilled rules from past episodes — call `memory.lessons.recall { id }` to read the full principle), `### procedures` (pointer view of advisory how-to templates — call `memory.procedures.recall { id }` to read the `steps[]`; templates are guidance, not law — follow them or consciously deviate), `### recalled` / `### memory-index` and `memory.notes.recall` for past context. Store distilled facts, not full dumps. `### notice` in the tail is a hard nudge to change strategy.",
].join("\n");

export function buildStablePrefix(input: StablePrefixInput): string {
  const persona = input.systemPersona ?? DEFAULT_SYSTEM_PERSONA;
  const maxParallelToolCalls = input.maxParallelToolCalls ?? 8;
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
      ? input.skillCatalog.map(formatSkillCatalogLine).join("\n")
      : "(none installed)";
  // Head ordering. With `turnSystemOpen` (Gemma 4 turn-framing) the system
  // turn opens first and the reasoning token sits at the very top of it,
  // before `### system`. Otherwise the legacy monolithic head is preserved
  // byte-for-byte so qwen/plain KV-cache is untouched.
  const head = input.turnSystemOpen
    ? [
        input.turnSystemOpen.trimEnd(),
        ...(input.reasoningSystemToken
          ? [input.reasoningSystemToken.trimEnd()]
          : []),
        `### system`,
      ]
    : [
        `### system`,
        ...(input.reasoningSystemToken
          ? [input.reasoningSystemToken.trimEnd()]
          : []),
      ];
  return [
    ...head,
    persona,
    ``,
    `### rules`,
    `One tool-call array per step (including \`skill.view\`); a solo action is a length-1 array. Destructive or privileged tools may require user approval. If \`### skills\` lists a playbook that fits the user goal, call \`skill.view\` first unless that skill is already under \`### loaded-skills\`; do not act on a catalog stub — the body has the procedure. This holds for every skill (text replies included), not just browser/shell shortcuts. Summaries in \`# extras\` list rare tools; call \`tool.view\` to load the full \`args\` schema into \`### loaded-tools\` before use. Large trees: narrow with \`os.fs.list\` filters or \`os.fs.glob\` before reading content; do not use \`os.fs.grep\` with broad binary globs (e.g. every \`*.pdf\`) across huge folders—use tight globs then \`os.fs.read_document\` on candidates.`,
    ``,
    `### skills`,
    skills,
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
    `### instructions`,
    `Emit a JSON ARRAY of tool calls now. Always start with \`[\` and end with \`]\`, even for a single call. Use \`reply\` for natural-language answers to the user.`,
    `PARALLEL: when you need multiple INDEPENDENT actions (e.g. read 3 different files, run 2 globs, look up 4 git logs), put up to ${maxParallelToolCalls} calls in the SAME array — they run in parallel and cut wall time by ~Nx. Examples:`,
    `  - one call: [{"tool":"os.fs.read","args":{"path":"a.ts"}}]`,
    `  - parallel batch: [{"tool":"os.fs.read","args":{"path":"a.csv"}},{"tool":"os.fs.read","args":{"path":"b.csv"}},{"tool":"os.fs.read","args":{"path":"c.csv"}}]`,
    `  - reply: [{"tool":"reply","args":{"text":"..."}}]`,
    `Keep a call solo (length-1 array) when: it is \`reply\`/\`finish\`, may need approval (\`os.shell.run\`, \`os.fs.write\`, \`os.fs.edit\`, \`os.fs.trash\`, \`os.fs.patch\`, \`os.fs.archive.extract\`, \`os.proc.kill\`, \`os.http.request\`, \`skill.run_script\`), or its args depend on a previous call's result.`,
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

