import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { commandUsesArgs, parseCommandFile, substituteCommandArgs } from "./plugin-commands.js";
import { extractShellSlots, type ShellSlot } from "./command-shell.js";

/**
 * The operator's own slash commands (ATO-2229): Markdown prompt templates
 * in the same format as plugin commands, without packaging a plugin.
 * Precedent: Claude Code `.claude/commands` and `~/.claude/commands`,
 * Gemini CLI `.gemini/commands`, Kilo `.kilo/commands`.
 *
 * Folders, first match wins on a name:
 * 1. `<project>/.atomic-agent/commands/`, then `<project>/.claude/commands/`
 *    (only while the operator trusts the folder, like project skills);
 * 2. `<stateDir>/commands/` (the profile, `~/.atomic-agent/commands/`);
 * 3. `~/.claude/commands/`, Claude Code's own user commands (ATO-2441),
 *    read where they are so a person moving over keeps them.
 * Plugin commands come after all three. `team/review.md` becomes `/team:review`.
 *
 * Rendering follows the plugin rules ($ARGUMENTS, $1..$9) and turns
 * Gemini's `@{path}` into Claude's `@path`; the frontend then inlines
 * `@path` files exactly as for a typed message (inside the working folder
 * only). Shell lines (`` !`command` ``, `!{command}`) come back as slots
 * that run only at invocation, through the normal approval
 * (`command-shell.ts`, `command-shell-runner.ts`).
 */
export type UserCommandSource = "project" | "profile" | "claude";

export interface UserCommand {
  /** Lower-cased name, nested folders joined with `:`. */
  name: string;
  source: UserCommandSource;
  description: string;
  argumentHint?: string;
  /** Frontmatter `model`; carried for the frontends, the turn still runs on the current model. */
  model?: string;
  /** The body has shell lines, which run (and ask) only when it is invoked. */
  runsShell?: boolean;
  file: string;
  /** The commands folder the file was found in. */
  dir: string;
}

/** An invocation ready to send, except for its shell lines. */
export interface RenderedUserCommand {
  command: UserCommand;
  /** The message, with one marker per shell slot. */
  text: string;
  slots: ShellSlot[];
  /** Fills `$ARGUMENTS` / `$1`.. into a slot's line before it runs. */
  fillShellLine(line: string): string;
}

export interface UserCommandOptions {
  stateDir: string;
  /** The session's working folder: project commands and `@file` paths are relative to it. */
  workingDir: string;
  /** Whether the operator trusts the working folder; project commands load only then. */
  projectTrusted: boolean;
  /** Claude Code's user commands folder (`~/.claude/commands`); absent, it is not read. */
  claudeCommandsDir?: string;
}

export const PROJECT_COMMAND_DIRS: readonly string[] = [".atomic-agent/commands", ".claude/commands"];
export const PROFILE_COMMAND_DIR = "commands";

const MAX_COMMAND_BYTES = 128 * 1024;
const MAX_DEPTH = 3;
const MAX_FILES_PER_DIR = 200;
const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** The folders searched, in precedence order. */
export function userCommandDirs(options: UserCommandOptions): Array<{ dir: string; source: UserCommandSource }> {
  const profile = resolve(options.stateDir, PROFILE_COMMAND_DIR);
  const claude = options.claudeCommandsDir ? resolve(options.claudeCommandsDir) : null;
  const project = options.projectTrusted
    ? projectCommandDirs(options).filter(dir => dir !== profile && dir !== claude)
    : [];
  return [
    ...project.map(dir => ({ dir, source: "project" as const })),
    { dir: profile, source: "profile" as const },
    ...(claude !== null && claude !== profile ? [{ dir: claude, source: "claude" as const }] : []),
  ];
}

function projectCommandDirs(options: UserCommandOptions): string[] {
  return PROJECT_COMMAND_DIRS.map(d => resolve(options.workingDir, d));
}

/**
 * How many command files the working folder ships that stay hidden
 * because the folder is not trusted yet (0 when it is trusted), so a
 * frontend can say why `/review` is missing instead of hiding it silently.
 * A project folder that is also the profile or Claude folder (a chat in
 * the home folder) is not counted: those load anyway.
 */
export function hiddenProjectCommandCount(options: UserCommandOptions): number {
  if (options.projectTrusted) return 0;
  const shown = new Set(userCommandDirs(options).map(d => d.dir));
  return projectCommandDirs(options).filter(dir => !shown.has(dir))
    .reduce((n, dir) => n + commandFiles(dir).length, 0);
}

export function listUserCommands(options: UserCommandOptions): { commands: UserCommand[]; diagnostics: string[] } {
  const commands: UserCommand[] = [];
  const diagnostics: string[] = [];
  const seen = new Set<string>();
  for (const { dir, source } of userCommandDirs(options)) {
    for (const { file, segments } of commandFiles(dir)) {
      const name = segments.join(":").toLowerCase();
      if (!segments.every(s => SEGMENT_RE.test(s.toLowerCase()))) {
        diagnostics.push(`${file}: "${name}" is not a valid command name`);
        continue;
      }
      if (seen.has(name)) continue;
      try {
        const parsed = readCommand(file);
        seen.add(name);
        commands.push({
          name,
          source,
          description: parsed.description || name,
          ...(parsed.argumentHint ? { argumentHint: parsed.argumentHint } : {}),
          ...(parsed.model ? { model: parsed.model } : {}),
          ...(hasShellLines(parsed.body) ? { runsShell: true } : {}),
          file,
          dir,
        });
      } catch (err) {
        diagnostics.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { commands, diagnostics };
}

/**
 * Render `/name args` into the user's message, or null when no user
 * command has that name (the caller then tries plugin commands). The
 * folders are read again, so a file removed or a folder untrusted after
 * the palette was drawn no longer runs. Shell lines are cut out first and
 * come back as slots, so text from the arguments never becomes one; the
 * `ARGUMENTS:` fallback still looks at the whole body, lines included.
 */
export function renderUserCommand(options: UserCommandOptions, name: string, args: string): RenderedUserCommand | null {
  const key = name.toLowerCase();
  const command = listUserCommands(options).commands.find(c => c.name === key);
  if (!command) return null;
  const parsed = readCommand(command.file);
  const vars = { root: command.dir, data: command.dir };
  const { body, slots } = extractShellSlots(parsed.body);
  const trimmedArgs = args.trim();
  let text = substituteCommandArgs(body, args, vars).trimEnd();
  if (trimmedArgs && !commandUsesArgs(parsed.body)) text = `${text}\n\nARGUMENTS: ${trimmedArgs}`;
  return {
    command,
    text: text.replace(BRACED_INCLUDE_RE, "@$1"),
    slots,
    fillShellLine: line => substituteCommandArgs(line, args, vars),
  };
}

function hasShellLines(body: string): boolean {
  try {
    return extractShellSlots(body).slots.length > 0;
  } catch {
    return true; // too many lines: it still cannot run without asking
  }
}

/** Gemini CLI's `@{path}` form; a path with spaces stays as written. */
const BRACED_INCLUDE_RE = /@\{([^\s{}]+)\}/g;

function readCommand(file: string) {
  if (statSync(file).size > MAX_COMMAND_BYTES) throw new Error("larger than 128 KiB");
  return parseCommandFile(readFileSync(file, "utf8"));
}

/** `*.md` files under `dir`, sorted, symlinks skipped; a missing folder is empty. */
function commandFiles(dir: string): Array<{ file: string; segments: string[] }> {
  const out: Array<{ file: string; segments: string[] }> = [];
  const walk = (current: string, prefix: string[]): void => {
    if (prefix.length > MAX_DEPTH || out.length >= MAX_FILES_PER_DIR) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_FILES_PER_DIR) return;
      if (entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path, [...prefix, entry.name]);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        out.push({ file: path, segments: [...prefix, entry.name.slice(0, -3)] });
      }
    }
  };
  walk(dir, []);
  return out;
}
