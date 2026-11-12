/**
 * ATO-1424 — open Terminal.app in a chat's folder with a command typed into
 * the input line but NOT run (the "Open in Terminal" button on a code block,
 * ATO-1236, calls this through `terminal:openWithCommand`).
 *
 * The rule this module is built around: the command text never becomes part
 * of a script, an AppleScript or a shell string. Per launch we make a private
 * folder (0700) in the app's temp folder:
 *
 *   <root>/atomic-terminal-XXXXXX/
 *     open.command   our launcher, the same bytes every time (0700)
 *     cmd            the command text, as data (0600)
 *     cwd            the folder to open in, as data (0600)
 *     zdot/.zshenv   our zsh hook, the same bytes every time (0600)
 *
 * `open -a Terminal <dir>/open.command` (execFile, args array, no shell) makes
 * Terminal run the launcher. It finds its siblings from its own path ($0),
 * cds into the folder, and:
 *   - zsh (the macOS default): starts a login, interactive zsh with
 *     ZDOTDIR pointing at our zdot folder. Our .zshenv puts ZDOTDIR back to
 *     the person's own (or unsets it), loads their real .zshenv, and adds a
 *     one-shot precmd hook; every other startup file (.zprofile, .zshrc,
 *     .zlogin, /etc/zshrc) then loads exactly as in a normal Terminal window.
 *     Just before the first prompt the hook does `print -rz -- "$(<cmd)"`,
 *     which puts the text in the input line raw (-r: no escape processing),
 *     multi-line included, and deletes the launch folder.
 *   - any other shell: prints the command, copies it with pbcopy, says
 *     "press Cmd+V", deletes the launch folder and starts that shell.
 * No AppleScript "tell Terminal", so no Automation permission prompt.
 *
 * Folders a launch never got to delete (Terminal did not start, the window
 * was closed early) are swept on the next app start and before each launch.
 *
 * Pure apart from the fs calls and the injected execFile, so the unit tests
 * (test/terminal-open.test.mjs) can drive it without Electron.
 */

import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const TERMINAL_COMMAND_MAX_BYTES = 64 * 1024;
export const LAUNCH_DIR_PREFIX = "atomic-terminal-";
/** At start no launch of ours is in flight; a minute covers a second window opening at the same time. */
export const SWEEP_AT_START_MS = 60_000;
/** Before a launch, only folders old enough that Terminal has long read them. */
export const SWEEP_BEFORE_LAUNCH_MS = 10 * 60_000;

export type TerminalOpenError =
  | "unsupported"
  | "invalid-request"
  | "empty-command"
  | "command-too-long"
  | "control-characters"
  | "open-failed";

export type TerminalOpenAnswer =
  | { ok: true; cwd: string; usedHome: boolean }
  | { ok: false; error: TerminalOpenError; message: string };

const MESSAGES: Record<TerminalOpenError, string> = {
  "unsupported": "Opening a command in Terminal is only available on macOS for now.",
  "invalid-request": "Nothing to open: the command is missing.",
  "empty-command": "The command is empty.",
  "command-too-long": "The command is too long to open in Terminal (over 64 KB).",
  "control-characters": "The command contains hidden control characters, so it was not opened in Terminal.",
  "open-failed": "Terminal could not be opened.",
};

function fail(error: TerminalOpenError, detail?: string): TerminalOpenAnswer {
  return { ok: false, error, message: detail ? `${MESSAGES[error]} ${detail}` : MESSAGES[error] };
}

/**
 * C0 controls other than tab and newline, DEL, C1 controls, and the bidi
 * overrides/isolates ("Trojan Source"): a terminal would act on the first
 * ones, and the last ones make the line on screen read differently from what
 * runs. A real shell command has none of them.
 */
const HIDDEN_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

export type CommandVerdict = { ok: true; text: string } | { ok: false; error: TerminalOpenError };

/** The command as it will sit in the input line: CRLF/CR → LF, no blank lines around it. */
export function checkCommand(raw: unknown): CommandVerdict {
  if (typeof raw !== "string") return { ok: false, error: "invalid-request" };
  // Byte cap on the raw input first, so a huge string is refused before any work.
  if (Buffer.byteLength(raw, "utf8") > TERMINAL_COMMAND_MAX_BYTES) return { ok: false, error: "command-too-long" };
  const text = raw.replace(/\r\n?/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "");
  if (text.trim() === "") return { ok: false, error: "empty-command" };
  if (HIDDEN_CHARS.test(text)) return { ok: false, error: "control-characters" };
  return { ok: true, text };
}

/**
 * The folder to open in: an absolute path (a leading `~` means home) that is
 * an existing directory, else the home folder. A newline or NUL in the path is
 * refused too: the launcher reads the path back as one line of text.
 */
export function resolveFolder(raw: unknown, home: string, isDir: (p: string) => boolean = defaultIsDir): { cwd: string; usedHome: boolean } {
  if (typeof raw === "string" && raw !== "" && !/[\n\r\0]/.test(raw)) {
    const expanded = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
    if (isAbsolute(expanded)) {
      const p = resolve(expanded);
      if (isDir(p)) return { cwd: p, usedHome: false };
    }
  }
  return { cwd: home, usedHome: true };
}

function defaultIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The launcher Terminal runs. Constant: it holds no command and no path, and
 * reads both from the files next to it. Every expansion is double-quoted.
 */
export const LAUNCHER_SCRIPT = `#!/bin/sh
# Atomic Agent: opens this window in the chat's folder with a command typed
# into the input line, not run. This file never changes: the command and the
# folder are read from the files next to it.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
dir=$(cat -- "$here/cwd" 2>/dev/null)
cd -- "$dir" 2>/dev/null || cd -- "$HOME" || exit 1
user_shell=\${SHELL:-/bin/zsh}
case "\${user_shell##*/}" in
  zsh)
    ATOMIC_TERMINAL_DIR=$here
    ATOMIC_USER_ZDOTDIR=\${ZDOTDIR-}
    ZDOTDIR=$here/zdot
    export ATOMIC_TERMINAL_DIR ATOMIC_USER_ZDOTDIR ZDOTDIR
    exec "$user_shell" -l -i
    ;;
esac
# Not zsh: the command goes to the clipboard and on screen instead.
pbcopy < "$here/cmd" 2>/dev/null
printf '\\n%s\\n\\n' 'Atomic Agent: the command below is in your clipboard. Press Cmd+V to paste it, then Enter to run it.'
cat -- "$here/cmd"
printf '\\n\\n'
rm -rf -- "$here"
exec "$user_shell" -l
`;

/**
 * Our $ZDOTDIR/.zshenv. It hands ZDOTDIR straight back, so the person's own
 * startup files load as in any Terminal window (including macOS /etc/zshrc,
 * which places history and session files under ZDOTDIR), then types the
 * command into the first prompt's input line from a one-shot precmd hook.
 */
export const ZSHENV_SCRIPT = `# Atomic Agent (see ../open.command). Puts your own ZDOTDIR back first.
if [[ -n "$ATOMIC_USER_ZDOTDIR" ]]; then
  ZDOTDIR=$ATOMIC_USER_ZDOTDIR
else
  unset ZDOTDIR
fi
[[ -r "\${ZDOTDIR:-$HOME}/.zshenv" ]] && builtin source "\${ZDOTDIR:-$HOME}/.zshenv"

__atomic_agent_type_command() {
  precmd_functions=(\${precmd_functions:#__atomic_agent_type_command})
  local d=$ATOMIC_TERMINAL_DIR want
  unset ATOMIC_TERMINAL_DIR ATOMIC_USER_ZDOTDIR
  [[ -n "$d" && -d "$d" ]] || return 0
  want=$(<"$d/cwd") 2>/dev/null
  # Back in the chat's folder even if a startup file moved elsewhere.
  [[ -n "$want" && "$PWD" != "$want" ]] && builtin cd -- "$want" 2>/dev/null
  # Into the input line, raw and in full; nothing runs until Enter.
  [[ -r "$d/cmd" ]] && builtin print -rz -- "$(<"$d/cmd")"
  command rm -rf -- "$d"
  return 0
}
typeset -ga precmd_functions
precmd_functions+=(__atomic_agent_type_command)
`;

export interface LaunchFiles {
  dir: string;
  launcher: string;
}

/** Make the root (0700, ours, not a symlink) and one launch folder in it with the four files. */
export function writeLaunchFiles(root: string, command: string, cwd: string): LaunchFiles {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const st = lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("the temp folder is not a plain folder");
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error("the temp folder belongs to someone else");
  chmodSync(root, 0o700);
  const dir = mkdtempSync(join(root, LAUNCH_DIR_PREFIX));
  chmodSync(dir, 0o700);
  try {
    // wx: never follow or reuse something already there.
    writeFileSync(join(dir, "cmd"), command, { mode: 0o600, flag: "wx" });
    writeFileSync(join(dir, "cwd"), cwd, { mode: 0o600, flag: "wx" });
    mkdirSync(join(dir, "zdot"), { mode: 0o700 });
    writeFileSync(join(dir, "zdot", ".zshenv"), ZSHENV_SCRIPT, { mode: 0o600, flag: "wx" });
    const launcher = join(dir, "open.command");
    writeFileSync(launcher, LAUNCHER_SCRIPT, { mode: 0o700, flag: "wx" });
    // The umask can only take bits away; set the exact modes.
    chmodSync(join(dir, "cmd"), 0o600);
    chmodSync(join(dir, "cwd"), 0o600);
    chmodSync(launcher, 0o700);
    return { dir, launcher };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Remove launch folders older than `maxAgeMs` (by mtime). Never throws; returns how many went. */
export function sweepLaunchDirs(root: string, maxAgeMs: number, now: number = Date.now()): number {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(LAUNCH_DIR_PREFIX)) continue;
    const p = join(root, name);
    try {
      const st = lstatSync(p);
      if (now - st.mtimeMs < maxAgeMs) continue;
      rmSync(p, { recursive: true, force: true });
      removed++;
    } catch {
      /* gone already, or not ours to remove */
    }
  }
  return removed;
}

export interface TerminalOpenDeps {
  platform: NodeJS.Platform;
  home: string;
  /** The app's own temp folder for launches, e.g. join(app.getPath("temp"), "atomic-agent-terminal"). */
  root: string;
  /** execFile with an args array; resolves when the program exits 0. */
  execFile: (file: string, args: string[]) => Promise<void>;
  isDir?: (p: string) => boolean;
  now?: () => number;
}

export const OPEN_BIN = "/usr/bin/open";

/** The `terminal:openWithCommand` route. Never throws. */
export async function openTerminalWithCommand(payload: unknown, deps: TerminalOpenDeps): Promise<TerminalOpenAnswer> {
  if (deps.platform !== "darwin") return fail("unsupported");
  if (!payload || typeof payload !== "object") return fail("invalid-request");
  const { command, cwd: rawCwd } = payload as { command?: unknown; cwd?: unknown };
  const verdict = checkCommand(command);
  if (!verdict.ok) return fail(verdict.error);
  const { cwd, usedHome } = resolveFolder(rawCwd, deps.home, deps.isDir);

  sweepLaunchDirs(deps.root, SWEEP_BEFORE_LAUNCH_MS, (deps.now ?? Date.now)());
  let files: LaunchFiles;
  try {
    files = writeLaunchFiles(deps.root, verdict.text, cwd);
  } catch (err) {
    return fail("open-failed", err instanceof Error ? err.message : undefined);
  }
  try {
    await deps.execFile(OPEN_BIN, ["-a", "Terminal", files.launcher]);
  } catch (err) {
    rmSync(files.dir, { recursive: true, force: true });
    return fail("open-failed", err instanceof Error ? err.message : undefined);
  }
  return { ok: true, cwd, usedHome };
}
