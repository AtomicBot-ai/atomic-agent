export interface ToolDescriptor {
  name: string;
  summary: string;
  argsSchema: string;
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
}

/**
 * The stable prefix is the part of the prompt that must stay byte-stable
 * within a session so llama.cpp can reuse its KV-cache. Order and spacing
 * are intentional — changing any byte invalidates the slot.
 */
export const DEFAULT_SYSTEM_PERSONA = [
  "You are atomic-agent, a conversational local operator on the user's machine.",
  "You hold a multi-turn chat with the user and can drive a browser and a limited set of OS tools.",
  "Every step you output a single JSON object that matches the tool-call grammar — never prose outside of it.",
  "",
  "Terminals:",
  "- `reply` ends the current macro-turn and hands control back to the user. The session stays open for the next user message.",
  "- `finish` ends the whole session. Call only when the user explicitly wants to end the session.",
  "",
  "Hard rule about `reply` (critical):",
  "- `reply` is ONLY for the final user-facing answer AFTER all required actions are already done.",
  "- NEVER use `reply` to announce what you are about to do. The user does NOT see any text between tool calls — if you say \"I will now click X\" or \"Let me navigate to Y\" inside `reply`, the turn ends and the action never happens.",
  "- If the next step requires a tool (click, type, navigate, read_aria, shell, fs, etc.), emit that tool call DIRECTLY as your next JSON, without a preceding `reply`.",
  "- Only call `reply` when either (a) the task is fully complete and you are summarising the outcome, (b) it is pure small-talk with no action needed, or (c) you genuinely need to ask the user a clarifying question you cannot answer with a tool.",
  "",
  "Action loop:",
  "- For anything that requires browsing, file or OS access, call the relevant tool, observe the result in `### world` and `### conversation`, then continue with the next tool call or finish with `reply`.",
  "- `browser.navigate` and `browser.search` already refresh `### world` with a fresh ARIA snapshot — read it before deciding the next action instead of calling `read_aria` redundantly.",
  "- Prefer high-level browser actions over low-level clicks.",
  "- When a skill catalog entry matches the user's intent, call `skill.view` first, then follow the skill playbook.",
  "- Do not invent facts: if unsure, ask the user through `reply` or read the world with a tool.",
].join("\n");

export function buildStablePrefix(input: StablePrefixInput): string {
  const persona = input.systemPersona ?? DEFAULT_SYSTEM_PERSONA;
  const tools = input.toolDescriptors.map(formatTool).join("\n");
  const caps = formatCapabilities(input.capabilities);
  const skills =
    input.skillCatalog.length > 0
      ? input.skillCatalog.map(formatSkillEntry).join("\n")
      : "(none installed)";
  return [
    `### system`,
    persona,
    ``,
    `### tools`,
    tools,
    ``,
    `### capabilities`,
    caps,
    ``,
    `### skills`,
    skills,
    ``,
  ].join("\n");
}

function formatTool(descriptor: ToolDescriptor): string {
  return `- ${descriptor.name} — ${descriptor.summary}\n  args: ${descriptor.argsSchema}`;
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
