import { homedir } from "node:os";
import { join } from "node:path";
import { listPluginCommands, renderPluginCommand } from "./plugin-commands.js";
import { fillShellSlots, type CommandShellRunner } from "./command-shell.js";
import {
  listUserCommands,
  NOT_TRUSTED_REASON,
  renderUserCommand,
  type UserCommand,
  type UserCommandOptions,
  type UserCommandProblem,
  type UserCommandSource,
} from "./user-commands.js";

/**
 * One listing and one render route for slash commands, shared by the
 * terminal (`tui/skills/skills-orchestrator.ts`) and the HTTP API the
 * desktop menu reads (`http/route-commands.ts`), so both show the same
 * commands in the same order and send the same message (ATO-2441).
 * Order: own commands (project, profile, `~/.claude/commands`), then
 * plugin commands; a frontend still lets its built-ins win.
 */
export type CommandSource = UserCommandSource | "plugin";

export interface CommandRow {
  /** What the person types after `/`: `review`, `team:review`, `tools:review`. */
  name: string;
  /** A plugin command's own name (`review` of `tools:review`), the short alias candidate; the name itself otherwise. */
  command: string;
  description: string;
  argumentHint?: string;
  source: CommandSource;
  /** Frontmatter `model` of an own command; the turn still runs on the current model. */
  model?: string;
  /** Whether invoking it runs shell lines (each one asks as usual). */
  runsShell?: boolean;
}

export interface CommandCatalog {
  rows: CommandRow[];
  diagnostics: string[];
  /** Project command files hidden until their exact text is trusted (ATO-2531). */
  hiddenProjectCommands: number;
  /** The own-command listing the rows came from, for the terminal's per-file warnings (ATO-2773). */
  own: { commands: UserCommand[]; problems: UserCommandProblem[] };
}

/**
 * `~/.claude/commands`, Claude Code's user commands, read as a compatible
 * folder. `ATOMIC_AGENT_CLAUDE_COMMANDS_DIR` points it elsewhere, and set
 * to an empty value it is not read at all (tests set it, like the shared
 * skills folder).
 */
export function defaultClaudeCommandsDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | undefined {
  const override = env.ATOMIC_AGENT_CLAUDE_COMMANDS_DIR;
  if (override !== undefined) return override.trim() ? override : undefined;
  return join(home, ".claude", "commands");
}

export function listCommandCatalog(options: UserCommandOptions): CommandCatalog {
  const own = listUserCommands(options);
  const plugins = listPluginCommands(options.stateDir);
  const rows: CommandRow[] = own.commands.map(c => ({
    name: c.name, command: c.name, description: c.description, source: c.source,
    ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
    ...(c.model ? { model: c.model } : {}),
    ...(c.runsShell ? { runsShell: true } : {}),
  }));
  for (const c of plugins.commands) {
    rows.push({ name: c.name, command: c.command, description: c.description, source: "plugin",
      ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) });
  }
  const hiddenProjectCommands = own.problems.filter(p => p.reason === NOT_TRUSTED_REASON).length;
  return { rows, diagnostics: [...own.diagnostics, ...plugins.diagnostics], hiddenProjectCommands,
    own: { commands: own.commands, problems: own.problems } };
}

export interface PreparedCommand {
  /** The message to send as the person's own. */
  text: string;
  source: CommandSource;
  model?: string;
}

export interface PrepareCommandDeps {
  /** Runs one shell line through the normal approval (`createRegistryShellRunner`). */
  runShell: CommandShellRunner;
  /** The frontend's `@file` inlining, applied to an own command's text before shell output goes in. */
  expandMentions?: (text: string) => string;
}

/**
 * Whether `/name` needs the async path: an own command with shell lines.
 * Everything else renders at once, the way it did before shell lines ran.
 */
export function commandRunsShell(options: UserCommandOptions, name: string): boolean {
  const key = name.toLowerCase();
  return listUserCommands(options).commands.find(c => c.name === key)?.runsShell === true;
}

/**
 * Render `/name args` without running anything: plugin commands and own
 * commands without shell lines. Throws for an unknown name, and for an
 * own command with shell lines (call `prepareCommand` for those).
 */
export function prepareCommandNow(options: UserCommandOptions, name: string, args: string,
  expandMentions?: (text: string) => string): PreparedCommand {
  const own = renderUserCommand(options, name, args);
  if (own === null) {
    if (!name.includes(":")) throw new Error(`command /${name} is not available`);
    return { text: renderPluginCommand(options.stateDir, name, args), source: "plugin" };
  }
  if (own.slots.length > 0) throw new Error(`command /${name} runs shell lines; it needs the approval path`);
  return { text: expandMentions ? expandMentions(own.text) : own.text, source: own.command.source,
    ...(own.command.model ? { model: own.command.model } : {}) };
}

/**
 * Render `/name args`, running an own command's shell lines one by one
 * through `deps.runShell`. A line that is not allowed or fails throws
 * `CommandShellRefused` and nothing is sent. Mentions are inlined before
 * the output goes in, so a `@word` printed by a command is not read as a
 * file to attach.
 */
export async function prepareCommand(options: UserCommandOptions, name: string, args: string,
  deps: PrepareCommandDeps): Promise<PreparedCommand> {
  const own = renderUserCommand(options, name, args);
  if (own === null || own.slots.length === 0) return prepareCommandNow(options, name, args, deps.expandMentions);
  const base = deps.expandMentions ? deps.expandMentions(own.text) : own.text;
  const text = await fillShellSlots(base, own.slots, deps.runShell, own.fillShellLine);
  return { text, source: own.command.source, ...(own.command.model ? { model: own.command.model } : {}) };
}
