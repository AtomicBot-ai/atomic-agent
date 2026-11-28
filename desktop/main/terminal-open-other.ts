/**
 * ATO-1430 — "Open in Terminal" on Windows and Linux (terminal-open.ts is
 * the macOS one, and holds the checks both share).
 *
 * The command text never reaches an argv, a script or a shell string:
 *   - Windows: it goes on the clipboard. Windows Terminal (else PowerShell)
 *     opens in the chat's folder, and the app window says "paste with
 *     Ctrl+V, then Enter". Nothing is typed or run.
 *   - Linux: it goes on the clipboard and into a 0600 file of a private
 *     launch folder (writeLaunchFiles, as on macOS). The terminal runs our
 *     constant launcher, which cds into the folder and, when the shell is
 *     zsh, types the command into the first prompt's input line with the
 *     same .zshenv hook as macOS (`print -rz`); any other shell gets the
 *     command printed and "paste with Ctrl+Shift+V".
 * No terminal found: a clear message, the command still on the clipboard.
 *
 * ATO-2782: `shell: "powershell"` in the request (the Agents sheet sends it,
 * its launch line is PowerShell syntax) makes Windows Terminal open a
 * PowerShell tab, not its default profile (terminal-pick.ts). Any other
 * value is ignored; Linux and macOS ignore it too.
 *
 * Pure apart from the fs calls and the injected spawn, clipboard and lookup.
 */

import { rmSync } from "node:fs";

import { SWEEP_BEFORE_LAUNCH_MS, checkCommand, resolveFolder, sweepLaunchDirs, terminalFail, writeLaunchFiles } from "./terminal-open.js";
import type { LaunchFiles, TerminalOpenAnswer } from "./terminal-open.js";
import { noTerminalMessage, pasteHint, terminalChoices } from "./terminal-pick.js";
import type { TerminalChoice, Which } from "./terminal-pick.js";

/**
 * The Linux launcher. Constant, like the macOS one: it reads the folder and
 * the command from the files next to it. Linux terminals start a non-login
 * shell, so it does too.
 */
export const LINUX_LAUNCHER_SCRIPT = `#!/bin/sh
# Atomic Agent: opens this window in the chat's folder with a command typed
# into the input line (zsh) or on the clipboard, not run. This file never
# changes: the command and the folder are read from the files next to it.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
dir=$(cat -- "$here/cwd" 2>/dev/null)
cd -- "$dir" 2>/dev/null || cd -- "$HOME" || exit 1
user_shell=\${SHELL:-/bin/sh}
case "\${user_shell##*/}" in
  zsh)
    ATOMIC_TERMINAL_DIR=$here
    ATOMIC_USER_ZDOTDIR=\${ZDOTDIR-}
    ZDOTDIR=$here/zdot
    export ATOMIC_TERMINAL_DIR ATOMIC_USER_ZDOTDIR ZDOTDIR
    exec "$user_shell" -i
    ;;
esac
# Not zsh: the app already put the command on the clipboard; show it too.
printf '\\n%s\\n\\n' 'Atomic Agent: the command below is in your clipboard. Paste it with Ctrl+Shift+V, then press Enter to run it.'
cat -- "$here/cmd"
printf '\\n\\n'
rm -rf -- "$here"
exec "$user_shell" -i
`;

export interface OtherOpenDeps {
  platform: NodeJS.Platform;
  home: string;
  /** The app's temp folder for Linux launch folders (the same root as macOS). */
  root: string;
  which: Which;
  /** Starts `file args` in `cwd`, detached; true once it started, false on ENOENT and other spawn errors. */
  spawn: (choice: TerminalChoice, cwd: string) => Promise<boolean>;
  writeClipboard: (text: string) => void;
  /** The person's login shell ($SHELL), for the hint. */
  shell?: string | null;
  isDir?: (p: string) => boolean;
  now?: () => number;
}

/** The `terminal:openWithCommand` route on Windows and Linux. Never throws. */
export async function openOtherTerminalWithCommand(payload: unknown, deps: OtherOpenDeps): Promise<TerminalOpenAnswer> {
  const { platform } = deps;
  if (platform !== "win32" && platform !== "linux") return terminalFail("unsupported");
  if (!payload || typeof payload !== "object") return terminalFail("invalid-request");
  const { command, cwd: rawCwd, shell } = payload as { command?: unknown; cwd?: unknown; shell?: unknown };
  const verdict = checkCommand(command);
  if (!verdict.ok) return terminalFail(verdict.error);
  const { cwd, usedHome } = resolveFolder(rawCwd, deps.home, deps.isDir);

  // First, so the command is there to paste whatever happens next.
  try {
    deps.writeClipboard(verdict.text);
  } catch (err) {
    return terminalFail("open-failed", err instanceof Error ? err.message : undefined);
  }

  let files: LaunchFiles | null = null;
  if (platform === "linux") {
    sweepLaunchDirs(deps.root, SWEEP_BEFORE_LAUNCH_MS, (deps.now ?? Date.now)());
    try {
      files = writeLaunchFiles(deps.root, verdict.text, cwd, LINUX_LAUNCHER_SCRIPT);
    } catch (err) {
      return terminalFail("open-failed", err instanceof Error ? err.message : undefined);
    }
  }

  const choices = terminalChoices(platform, deps.which, files?.launcher, { powershell: shell === "powershell" });
  for (const choice of choices) {
    if (await deps.spawn(choice, cwd)) {
      return { ok: true, cwd, usedHome, terminal: choice.terminal, hint: pasteHint(platform, deps.shell) };
    }
  }
  if (files) rmSync(files.dir, { recursive: true, force: true });
  if (choices.length === 0) return { ok: false, error: "no-terminal", message: noTerminalMessage(platform) };
  return terminalFail("open-failed", undefined, "The command is on your clipboard.");
}
