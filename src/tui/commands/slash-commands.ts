import fuzzysort from "fuzzysort";

export interface SlashCommandDef {
  /** Canonical command name (without leading `/`). */
  readonly name: string;
  /** Short one-line description shown in the palette. */
  readonly description: string;
  /** Optional aliases matched in parsing but not shown in palette. */
  readonly aliases?: readonly string[];
}

/**
 * Atomic-agent's slash command registry. Intentionally small: the
 * handler-side dispatch in `slash-command-handler.ts` knows how to
 * action each name. Additions live here so the palette + parser stay
 * in sync by construction.
 */
export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  {
    name: "dump",
    description:
      "write debug zip (TUI snapshot + recent trace NDJSON) to ~/Documents/atomic-agent-debug",
  },
  { name: "help", description: "list available slash commands" },
  {
    name: "tools",
    description:
      "list built-in tools (fs, shell, browser, memory, vision): `/tools` | `/tools <query>`",
  },
  {
    name: "theme",
    description:
      "switch the UI theme: `/theme <name>` | `/theme list` (github, catppuccin, dracula, nord, …)",
  },
  { name: "clear", description: "clear chat transcript (keeps session)" },
  { name: "abort", description: "abort the running turn" },
  { name: "quit", description: "exit atomic-agent", aliases: ["exit"] },
  { name: "debug", description: "toggle debug pane (feed / logs / world …)" },
  { name: "chat", description: "return to single-view chat mode", aliases: ["run"] },
  {
    name: "observe",
    description:
      "switch to the Observe section (feed / world / reasoning / logs / llm-logs)",
  },
  {
    name: "manage",
    description:
      "switch to the Manage section (tasks / skills / LLM / telegram)",
  },
  { name: "feed", description: "jump to the Observe → Feed tab" },
  { name: "logs", description: "jump to the Observe → Logs tab" },
  { name: "reasoning", description: "jump to the Observe → Reasoning tab" },
  { name: "world", description: "jump to the Observe → World tab" },
  { name: "expand", description: "expand every tool card in the chat log" },
  { name: "collapse", description: "collapse every tool card in the chat log" },
  { name: "session", description: "show current session id" },
  { name: "sessions", description: "open session picker to switch threads" },
  { name: "new", description: "start a fresh session (keeps warm runtime)" },
  {
    name: "skills",
    description:
      "jump to the Skills tab · subcommand: `/skills dump` to print catalog in chat",
  },
  {
    name: "skill",
    description:
      "skill subcommand: `/skill enable <name>` | `/skill disable <name>`",
  },
  {
    name: "memory",
    description:
      "open Memory tab (profile, notes, lessons, …) · subcommand: `/memory dump` for profile in chat",
  },
  {
    name: "llm",
    description:
      "open LLM Local/Cloud/External panel · `/llm provider <id>` switch text provider",
  },
  {
    name: "mcp",
    description:
      "open MCP tab (configured servers + discovered tools / resources / prompts) · subcommands: `/mcp add` opens JSON-paste modal, `/mcp remove <name>` opens delete-confirm",
  },
  {
    name: "model",
    description:
      "open chat model picker · subcommands: pull <id> | use <id> | status | <base-url>",
    aliases: ["models", "local"],
  },
  {
    name: "max_steps",
    description:
      "get or set the agent's max_steps configuration: `/max_steps` | `/max_steps <number>`",
  },
  { name: "tasks", description: "jump to the Tasks tab (Option 4 cron + ingress UI)" },
  {
    name: "task",
    description:
      "task subcommand: `/task new` | `/task cancel <id>` | `/task run <id>`",
  },
  {
    name: "telegram",
    description:
      "telegram tab · subcommands: enable | disable | start | stop | restart | pair | token",
  },
  {
    name: "import",
    description: "open the Import tab (one-shot Hermes -> atomic-agent migration)",
  },
  {
    name: "privacy",
    description:
      "open the Privacy tab (analytics opt-out + approval level) · subcommands: `/privacy analytics on|off` | `/privacy level 1..5` | `/privacy approve on|off`",
  },
  {
    name: "analytics",
    description: "toggle anonymous analytics: `/analytics on|off|status`",
  },
];

/**
 * Filter the registry by a slash query (the characters typed after `/`).
 * Empty queries return the full list. Non-empty queries are scored via
 * fuzzysort against the name and aliases, preserving registry order on
 * ties.
 */
export function filterSlashCommands(query: string): readonly SlashCommandDef[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return SLASH_COMMANDS;
  const scored = SLASH_COMMANDS.map((cmd, idx) => {
    const candidates = [cmd.name, ...(cmd.aliases ?? [])];
    const scores = candidates.map(
      (candidate) => fuzzysort.single(q, candidate)?.score ?? -Infinity,
    );
    const bestScore = Math.max(...scores);
    return { cmd, score: bestScore, idx };
  });
  return scored
    .filter(({ score }) => score > -Infinity)
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .map(({ cmd }) => cmd);
}

/** Resolve an alias or canonical name to the registry entry. */
export function resolveSlashCommand(name: string): SlashCommandDef | null {
  const needle = name.trim().toLowerCase();
  for (const cmd of SLASH_COMMANDS) {
    if (cmd.name === needle) return cmd;
    if (cmd.aliases?.includes(needle)) return cmd;
  }
  return null;
}
