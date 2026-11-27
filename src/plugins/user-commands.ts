import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { frontMatterProblem } from "./command-front-matter.js";
import { parseCommandFile, renderCommandTemplate } from "./plugin-commands.js";

/**
 * The operator's own slash commands (ATO-2229): Markdown prompt templates
 * in the same format as plugin commands, without packaging a plugin.
 * Precedent: Claude Code `.claude/commands` and `~/.claude/commands`,
 * Gemini CLI `.gemini/commands`, Kilo `.kilo/commands`.
 *
 * Folders, first match wins on a name:
 * 1. `<project>/.atomic-agent/commands/`, then `<project>/.claude/commands/`
 *    (only while the operator trusts the folder, like project skills);
 * 2. `<stateDir>/commands/` (the profile, `~/.atomic-agent/commands/`).
 * Plugin commands come after both. `team/review.md` becomes `/team:review`.
 *
 * Rendering follows the plugin rules ($ARGUMENTS, $1..$9) and turns
 * Gemini's `@{path}` into Claude's `@path`; the terminal then inlines
 * `@path` files exactly as for a typed message (inside the working folder
 * only). Nothing is executed: `` !`command` `` stays plain text.
 */
export type UserCommandSource = "project" | "profile";

export interface UserCommand {
  /** Lower-cased name, nested folders joined with `:`. */
  name: string;
  source: UserCommandSource;
  description: string;
  argumentHint?: string;
  file: string;
  /** The commands folder the file was found in. */
  dir: string;
}

export interface UserCommandOptions {
  stateDir: string;
  /** The session's working folder: project commands and `@file` paths are relative to it. */
  workingDir: string;
  /** Whether the operator trusts the working folder; project commands load only then. */
  projectTrusted: boolean;
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

export const PROJECT_COMMAND_DIRS: readonly string[] = [".atomic-agent/commands", ".claude/commands"];
export const PROFILE_COMMAND_DIR = "commands";

const MAX_COMMAND_BYTES = 128 * 1024;
const MAX_DEPTH = 3;
const MAX_FILES_PER_DIR = 200;
const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** The folders searched, in precedence order. */
export function userCommandDirs(options: UserCommandOptions): Array<{ dir: string; source: UserCommandSource }> {
  const profile = resolve(options.stateDir, PROFILE_COMMAND_DIR);
  const project = options.projectTrusted
    ? PROJECT_COMMAND_DIRS.map(d => resolve(options.workingDir, d)).filter(dir => dir !== profile)
    : [];
  return [...project.map(dir => ({ dir, source: "project" as const })), { dir: profile, source: "profile" as const }];
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
 * folders are read again, so a file removed or a folder untrusted after
 * the palette was drawn no longer runs.
 */
export function renderUserCommand(options: UserCommandOptions, name: string, args: string): string | null {
  const key = name.toLowerCase();
  const command = listUserCommands(options).commands.find(c => c.name === key);
  if (!command) return null;
  const parsed = readCommand(command.file);
  const rendered = renderCommandTemplate(parsed.body, args, { root: command.dir, data: command.dir });
  return rendered.replace(BRACED_INCLUDE_RE, "@$1");
}

/** Gemini CLI's `@{path}` form; a path with spaces stays as written. */
const BRACED_INCLUDE_RE = /@\{([^\s{}]+)\}/g;

function readCommand(file: string) {
  return readCommandFile(file).parsed;
}

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
