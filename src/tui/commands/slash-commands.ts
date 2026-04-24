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
  { name: "help", description: "list available slash commands" },
  { name: "clear", description: "clear chat transcript (keeps session)" },
  { name: "abort", description: "abort the running turn" },
  { name: "quit", description: "exit atomic-agent", aliases: ["exit"] },
  { name: "debug", description: "toggle debug pane (feed / logs / world …)" },
  { name: "chat", description: "return to single-view chat mode" },
  { name: "feed", description: "jump to the debug Feed tab" },
  { name: "logs", description: "jump to the debug Logs tab" },
  { name: "reasoning", description: "jump to the debug Reasoning tab" },
  { name: "world", description: "jump to the debug World tab" },
  { name: "metrics", description: "jump to the debug Metrics tab" },
  { name: "expand", description: "expand every tool card in the chat log" },
  { name: "collapse", description: "collapse every tool card in the chat log" },
  { name: "session", description: "show current session id" },
  { name: "sessions", description: "open session picker to switch threads" },
  { name: "new", description: "start a fresh session (keeps warm runtime)" },
  { name: "skills", description: "list loaded skills" },
  { name: "memory", description: "dump the current user profile (cross-session facts)" },
  {
    name: "llama",
    description: "set llama-server base URL (health-check, save to config)",
  },
  { name: "tasks", description: "jump to the Tasks tab (Option 4 cron + ingress UI)" },
  {
    name: "task",
    description:
      "task subcommand: `/task new` | `/task cancel <id>` | `/task run <id>`",
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
