/**
 * ATO-1430 — which terminal "Open in Terminal" starts on Windows and Linux,
 * and with which argv. Pure: the PATH lookup comes in as `which`, so the unit
 * tests (test/terminal-pick.test.mjs) feed a fake one.
 *
 * The argv never holds the command. On Windows the command goes on the
 * clipboard; on Linux the terminal runs our constant launcher, which reads
 * the command from a file next to it (terminal-open-other.ts). The folder
 * is the spawn's cwd, not an argument, so a path with `;` (a Windows
 * Terminal subcommand separator) or a leading `-` cannot change the argv.
 *
 * Order, after VS Code's terminal.external.windowsExec / linuxExec and
 * GitHub Desktop's "Open in terminal":
 *   Windows: Windows Terminal (`wt.exe -d .`), else Windows PowerShell.
 *   Linux:   x-terminal-emulator (Debian/Ubuntu's chosen default),
 *            gnome-terminal, konsole, xterm.
 */

import { posix, win32 } from "node:path";

export type OtherTerminalName = "windows-terminal" | "powershell" | "x-terminal-emulator" | "gnome-terminal" | "konsole" | "xterm";

export interface TerminalChoice {
  terminal: OtherTerminalName;
  /** Absolute path the lookup found. */
  file: string;
  args: string[];
  /** Windows: give the program its own console window (spawn `detached`). */
  newConsole?: boolean;
}

/** Finds a program on PATH: its absolute path, or null. */
export type Which = (name: string) => string | null;

/**
 * Every terminal this platform could use, in order, that `which` finds.
 * `launcher` is the Linux launcher's path (each terminal runs it); unused on
 * Windows. An empty list means no terminal was found.
 */
export function terminalChoices(platform: NodeJS.Platform, which: Which, launcher?: string): TerminalChoice[] {
  const out: TerminalChoice[] = [];
  const add = (terminal: OtherTerminalName, name: string, args: string[], newConsole?: boolean) => {
    const file = which(name);
    if (file) out.push({ terminal, file, args, ...(newConsole ? { newConsole } : {}) });
  };
  if (platform === "win32") {
    // `-d .`: Windows Terminal's own folder, which is the spawn's cwd.
    add("windows-terminal", "wt.exe", ["-d", "."]);
    add("powershell", "powershell.exe", ["-NoLogo", "-NoExit"], true);
    return out;
  }
  if (platform === "linux") {
    if (!launcher) return out;
    add("x-terminal-emulator", "x-terminal-emulator", ["-e", launcher]);
    add("gnome-terminal", "gnome-terminal", ["--", launcher]);
    add("konsole", "konsole", ["-e", launcher]);
    add("xterm", "xterm", ["-e", launcher]);
  }
  return out;
}

/** The line the app window shows once the terminal opened. */
export function pasteHint(platform: NodeJS.Platform, shell?: string | null): string {
  if (platform === "win32") return "The command is on your clipboard. Paste it with Ctrl+V, then press Enter to run it.";
  if (platform === "linux" && shellIsZsh(shell)) {
    return "The command is typed into the terminal, not run: press Enter to run it. It is on your clipboard too.";
  }
  return "The command is on your clipboard. Paste it with Ctrl+Shift+V, then press Enter to run it.";
}

export function shellIsZsh(shell?: string | null): boolean {
  return typeof shell === "string" && /(?:^|\/)zsh$/.test(shell);
}

/** The message when nothing on the list is installed. */
export function noTerminalMessage(platform: NodeJS.Platform): string {
  // ATO-2742: plain words; which programs were looked for is in the header comment, not the toast.
  if (platform === "win32") return "No terminal was found on this computer: Windows Terminal and PowerShell are both missing. The command is on your clipboard, so you can paste it into any terminal.";
  return "No terminal was found on this computer. Install one, such as GNOME Terminal, Konsole or xterm. The command is on your clipboard.";
}

export interface WhichEnv {
  platform: NodeJS.Platform;
  path: string | undefined;
  /** Windows PATHEXT, e.g. ".COM;.EXE;.BAT". */
  pathExt?: string | undefined;
  isFile: (p: string) => boolean;
}

/** A plain PATH lookup, like `which` / `where`. Names with a separator are not looked up. */
export function makeWhich(env: WhichEnv): Which {
  const win = env.platform === "win32";
  const lib = win ? win32 : posix;
  const dirs = (env.path ?? "").split(win ? ";" : ":").map((d) => d.trim().replace(/^"(.*)"$/, "$1")).filter((d) => d && lib.isAbsolute(d));
  const exts = win ? (env.pathExt || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase()).filter(Boolean) : [""];
  return (name) => {
    if (!name || /[\\/]/.test(name)) return null;
    const hasExt = win && exts.includes(lib.extname(name).toLowerCase());
    for (const dir of dirs) {
      for (const ext of hasExt || !win ? [""] : exts) {
        const p = lib.join(dir, name + ext);
        if (env.isFile(p)) return p;
      }
    }
    return null;
  };
}
