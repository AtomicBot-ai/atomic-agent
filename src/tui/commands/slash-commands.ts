import fuzzysort from "fuzzysort";

import { toSlashCommands } from "../menu/menu-registry.js";
import type { SkillsPanelState } from "../skills/skills-panel-state.js";

export interface SlashCommandDef {
  /** Canonical command name (without leading `/`). */
  readonly name: string;
  /** Short one-line description shown in the palette. */
  readonly description: string;
  /** Optional aliases matched in parsing but not shown in palette. */
  readonly aliases?: readonly string[];
  /** Present only for workspace catalog commands; never a built-in alias. */
  readonly skillName?: string;
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

/** Cloud-only projection. Built-in names and aliases always keep their meaning. */
export function skillSlashCommands(panel: SkillsPanelState): readonly SlashCommandDef[] {
  if (!panel.workspace) return [];
  return panel.rows
    .filter(row => !row.disabled && resolveSlashCommand(row.name) === null)
    .map(row => ({ name: row.name, description: row.description, skillName: row.name }));
}

/**
 * Filter the registry by a slash query (the characters typed after `/`).
 * Empty queries return the full list. Non-empty queries are scored via
 * fuzzysort against the name and aliases, preserving registry order on
 * ties.
 */
export function filterSlashCommands(query: string, skills: readonly SlashCommandDef[] = []): readonly SlashCommandDef[] {
  const commands = skills.length ? [...SLASH_COMMANDS, ...skills] : SLASH_COMMANDS;
  const q = query.trim().toLowerCase();
  if (q.length === 0) return commands;
  const scored = commands.map((cmd, idx) => {
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
export function resolveSlashCommand(name: string, skills: readonly SlashCommandDef[] = []): SlashCommandDef | null {
  const needle = name.trim().toLowerCase();
  for (const cmd of SLASH_COMMANDS) {
    if (cmd.name === needle) return cmd;
    if (cmd.aliases?.includes(needle)) return cmd;
  }
  return skills.find(cmd => cmd.name === needle) ?? null;
}
