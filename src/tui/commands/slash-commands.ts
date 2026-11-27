import fuzzysort from "fuzzysort";

import { shortCommandAliases } from "../../plugins/plugin-commands.js";
import { toSlashCommands } from "../menu/menu-registry.js";
import type { PluginCommandRow, SkillsPanelState } from "../skills/skills-panel-state.js";

export interface SlashCommandDef {
  /** Canonical command name (without leading `/`). */
  readonly name: string;
  /** Short one-line description shown in the palette. */
  readonly description: string;
  /** Optional aliases matched in parsing but not shown in palette. */
  readonly aliases?: readonly string[];
  /** Search-only words: matched by the palette below names and aliases, never dispatched. */
  readonly keywords?: readonly string[];
  /** Present only for workspace catalog commands; never a built-in alias. */
  readonly skillName?: string;
  /** Present only for plugin commands: the full `plugin:command` name. */
  readonly pluginCommand?: string;
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
  ({ name, description, aliases, keywords }) => ({
    name,
    description,
    ...(aliases ? { aliases } : {}),
    ...(keywords ? { keywords } : {}),
  }),
);

/**
 * Everything the palette offers beyond the built-ins: enabled skills (the
 * cloud workspace catalog or the local registry, ATO-1469), then plugin
 * commands. Built-in names and aliases always keep their meaning.
 */
export function skillSlashCommands(panel: SkillsPanelState): readonly SlashCommandDef[] {
  const skills: SlashCommandDef[] = panel.rows
    .filter(row => !row.disabled && resolveSlashCommand(row.name) === null)
    .map(row => ({ name: row.name, description: row.description, skillName: row.name }));
  const plugins = pluginSlashCommands(panel.pluginCommands ?? [], skills);
  return plugins.length ? [...skills, ...plugins] : skills;
}

/**
 * Plugin commands as `/plugin:command`, plus the bare `/command` alias when
 * nothing else claims it. A built-in or a skill with the same name wins:
 * the plugin entry (or its alias) is dropped. The operator's own commands
 * (rows with a `source`) use their name as is and are tagged
 * `(project)`, `(profile)` or `(~/.claude)` in the palette.
 */
export function pluginSlashCommands(rows: readonly PluginCommandRow[], taken: readonly SlashCommandDef[] = []): readonly SlashCommandDef[] {
  if (rows.length === 0) return [];
  const takenNames = new Set(taken.map(cmd => cmd.name));
  // Rows arrive project, profile, then plugin commands: the first row with a name wins.
  const usable: PluginCommandRow[] = [];
  const usableNames = new Set<string>();
  for (const row of rows) {
    if (resolveSlashCommand(row.name) !== null || takenNames.has(row.name) || usableNames.has(row.name)) continue;
    usable.push(row);
    usableNames.add(row.name);
  }
  const aliases = shortCommandAliases(
    usable,
    alias => resolveSlashCommand(alias) !== null || takenNames.has(alias) || usableNames.has(alias),
  );
  return usable.map(row => {
    const alias = aliases.get(row.name);
    const described = row.argumentHint ? `${row.description} ${row.argumentHint}`.trim() : row.description;
    const description = row.source ? `${described} (${row.source === "claude" ? "~/.claude" : row.source})` : described;
    return alias
      ? { name: row.name, description, aliases: [alias], pluginCommand: row.name }
      : { name: row.name, description, pluginCommand: row.name };
  });
}

/**
 * Filter the registry by a slash query (the characters typed after `/`).
 * Empty queries return the full list. Non-empty queries are scored via
 * fuzzysort against the name and aliases, preserving registry order on
 * ties. A command found only through its search keywords comes after
 * every name or alias match, so `/fusion` still lists `/fusion` first
 * and Enter keeps running what was typed.
 */
export function filterSlashCommands(query: string, skills: readonly SlashCommandDef[] = []): readonly SlashCommandDef[] {
  const commands = skills.length ? [...SLASH_COMMANDS, ...skills] : SLASH_COMMANDS;
  const q = query.trim().toLowerCase();
  if (q.length === 0) return commands;
  const best = (candidates: readonly string[]): number =>
    Math.max(
      -Infinity,
      ...candidates.map((candidate) => fuzzysort.single(q, candidate)?.score ?? -Infinity),
    );
  const scored = commands.map((cmd, idx) => {
    const named = best([cmd.name, ...(cmd.aliases ?? [])]);
    if (named > -Infinity) return { cmd, tier: 0, score: named, idx };
    return { cmd, tier: 1, score: best(cmd.keywords ?? []), idx };
  });
  return scored
    .filter(({ score }) => score > -Infinity)
    .sort((a, b) => a.tier - b.tier || b.score - a.score || a.idx - b.idx)
    .map(({ cmd }) => cmd);
}

/** Resolve an alias or canonical name to the registry entry. */
export function resolveSlashCommand(name: string, skills: readonly SlashCommandDef[] = []): SlashCommandDef | null {
  const needle = name.trim().toLowerCase();
  for (const cmd of SLASH_COMMANDS) {
    if (cmd.name === needle) return cmd;
    if (cmd.aliases?.includes(needle)) return cmd;
  }
  return skills.find(cmd => cmd.name === needle)
    ?? skills.find(cmd => cmd.aliases?.includes(needle))
    ?? null;
}
