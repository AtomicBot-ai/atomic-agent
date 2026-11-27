import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { frontMatterProblem } from "./command-front-matter.js";
import { commandUsesArgs, parseCommandFile, substituteCommandArgs } from "./plugin-commands.js";
import { extractShellSlots, type ShellSlot } from "./command-shell.js";
import { projectCommandKey } from "./project-command-trust.js";

/**
 * The operator's own slash commands (ATO-2229): Markdown prompt templates
 * in the same format as plugin commands, without packaging a plugin.
 * Precedent: Claude Code `.claude/commands` and `~/.claude/commands`,
 * Gemini CLI `.gemini/commands`, Kilo `.kilo/commands`.
 *
 * Folders, first match wins on a name:
 * 1. `<project>/.atomic-agent/commands/`, then `<project>/.claude/commands/`
 *    (each file only once the operator trusted its exact text, ATO-2531:
 *    a new or edited file stays hidden until the folder trust question
 *    asks about it; an untrusted file does not hide a profile command);
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
  /**
   * Whether the operator trusted this project command file, by its trust
   * key (`projectCommandKey`: path and hash of the text). Project commands
   * load one by one, only when this says yes.
   */
  isProjectCommandTrusted: (key: string) => boolean;
  /** Claude Code's user commands folder (`~/.claude/commands`); absent, it is not read. */
  claudeCommandsDir?: string;
}

/**
 * A command file that did not load as written (ATO-2773). `skipped`
 * files are missing from the palette; the others load with defaults.
 * The terminal shows each one once (tui/skills/user-command-warnings.ts).
 */
export interface UserCommandProblem {
  file: string;
  reason: string;
  skipped: boolean;
}

/** The reason a project command file that waits for the trust question is reported with (ATO-2531). */
export const NOT_TRUSTED_REASON = "not trusted yet";

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
  const project = projectCommandDirs(options.workingDir, profile).filter(dir => dir !== claude);
  return [
    ...project.map(dir => ({ dir, source: "project" as const })),
    { dir: profile, source: "profile" as const },
    ...(claude !== null && claude !== profile ? [{ dir: claude, source: "claude" as const }] : []),
  ];
}

/**
 * How many project command files stay hidden because their exact text
 * was not trusted yet (ATO-2531), so a frontend can say why `/review` is
 * missing instead of hiding it silently (ATO-2441). A project folder that
 * is also the profile or Claude folder (a chat in the home folder) is not
 * counted: those load anyway.
 */
export function hiddenProjectCommandCount(options: UserCommandOptions): number {
  return listUserCommands(options).problems.filter(p => p.reason === NOT_TRUSTED_REASON).length;
}

export function listUserCommands(options: UserCommandOptions): {
  commands: UserCommand[];
  diagnostics: string[];
  problems: UserCommandProblem[];
} {
  const commands: UserCommand[] = [];
  const problems: UserCommandProblem[] = [];
  const seen = new Set<string>();
  for (const { dir, source } of userCommandDirs(options)) {
    for (const { file, segments } of commandFiles(dir)) {
      const name = segments.join(":").toLowerCase();
      if (!segments.every(s => SEGMENT_RE.test(s.toLowerCase()))) {
        problems.push({
          file,
          reason: `"${name}" is not a valid command name (use letters, digits, dots, dashes or underscores)`,
          skipped: true,
        });
        continue;
      }
      if (seen.has(name)) continue;
      try {
        const { parsed, content } = readCommandFile(file);
        const trustKey = source === "project" ? projectCommandKey(options.workingDir, file, content) : undefined;
        if (trustKey !== undefined && !options.isProjectCommandTrusted(trustKey)) {
          problems.push({ file, reason: NOT_TRUSTED_REASON, skipped: true });
          continue;
        }
        seen.add(name);
        const metaProblem = frontMatterProblem(content);
        if (metaProblem !== null) {
          problems.push({ file, reason: `${metaProblem}, so its description and argument hint are ignored`, skipped: false });
        }
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
        problems.push({ file, reason: readFailure(err), skipped: true });
      }
    }
  }
  const diagnostics = problems.map(p => `${p.file}: ${p.reason}`);
  return { commands, diagnostics, problems };
}

/**
 * Render `/name args` into the user's message, or null when no user
 * command has that name (the caller then tries plugin commands). The
 * folders are read again, so a file removed or one no longer trusted after
 * the palette was drawn no longer runs. Shell lines are cut out first and
 * come back as slots, so text from the arguments never becomes one; the
 * `ARGUMENTS:` fallback still looks at the whole body, lines included.
 */
export function renderUserCommand(options: UserCommandOptions, name: string, args: string): RenderedUserCommand | null {
  const key = name.toLowerCase();
  const command = listUserCommands(options).commands.find(c => c.name === key);
  if (!command) return null;
  const { parsed, content } = readCommandFile(command.file);
  // The text sent is the text read here: a file swapped after the listing
  // above is checked again rather than sent on the old answer.
  if (command.source === "project" && !options.isProjectCommandTrusted(projectCommandKey(options.workingDir, command.file, content))) {
    return null;
  }
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

function readCommandFile(file: string) {
  if (statSync(file).size > MAX_COMMAND_BYTES) throw new Error(TOO_LARGE);
  const content = readFileSync(file, "utf8");
  return { parsed: parseCommandFile(content), content };
}

const TOO_LARGE = "larger than 128 KiB";

/** Our own size message as is; a file system error in plain words. */
function readFailure(err: unknown): string {
  return err instanceof Error && err.message === TOO_LARGE ? TOO_LARGE : "the file could not be read";
}

function projectCommandDirs(workingDir: string, profile: string): string[] {
  return PROJECT_COMMAND_DIRS.map(d => resolve(workingDir, d)).filter(dir => dir !== profile);
}

/**
 * Every project command file the folder ships, as trust keys, for the
 * folder trust question (runtime/project-trust.ts). All valid files, not
 * only the first per name: a declined `.atomic-agent/commands/x.md` would
 * otherwise let an unasked `.claude/commands/x.md` take its name.
 */
export function listProjectCommandTrustKeys(workingDir: string, stateDir: string): string[] {
  const keys: string[] = [];
  for (const dir of projectCommandDirs(workingDir, resolve(stateDir, PROFILE_COMMAND_DIR))) {
    for (const { file, segments } of commandFiles(dir)) {
      if (!segments.every(s => SEGMENT_RE.test(s.toLowerCase()))) continue;
      try {
        keys.push(projectCommandKey(workingDir, file, readCommandFile(file).content));
      } catch {
        // Too large or unreadable: it never loads, so it is not asked about.
      }
    }
  }
  return keys;
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
