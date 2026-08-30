import fuzzysort from "fuzzysort";

import { toSlashCommands } from "../menu/menu-registry.js";

export interface SlashCommandDef {
  /** Canonical command name (without leading `/`). */
  readonly name: string;
  /** Short one-line description shown in the palette. */
  readonly description: string;
  /** Optional aliases matched in parsing but not shown in palette. */
  readonly aliases?: readonly string[];
}

/**
 * Atomic-agent's slash command registry — a **projection** of the
 * operator menu (`src/tui/menu/menu-registry.ts`), not a list of its
 * own. Every command is one menu node carrying a `slash` field, so the
 * palette and the menu cannot describe the same command differently.
 *
 * Order is the historical palette order, carried on `MenuSlash.rank`:
 * an empty query lists the registry as-is, and fuzzy-search ties break
 * by index, so both are user-visible.
 *
 * To add a command, add the node to `MENU`. The handler-side dispatch in
 * `slash-command-handler.ts` still knows how to action each name.
 */
export const SLASH_COMMANDS: readonly SlashCommandDef[] = toSlashCommands().map(
  ({ name, description, aliases }) =>
    aliases ? { name, description, aliases } : { name, description },
);

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
