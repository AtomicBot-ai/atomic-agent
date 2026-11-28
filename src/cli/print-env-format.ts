/**
 * ATO-2758: the lines `atag launch --print-env` prints, in the syntax of
 * the shell they are pasted into. `export NAME=value` works in sh, bash
 * and zsh only; on Windows the default is PowerShell (`$env:NAME = '...'`),
 * the shell Windows Terminal opens, and `--shell cmd` gives `set "NAME=..."`
 * for the old Command Prompt. Same split as the Docker and Azure CLIs,
 * which print `$Env:` lines for PowerShell and `SET` lines for cmd.
 */

export type PrintEnvShell = "posix" | "powershell" | "cmd";

export const PRINT_ENV_SHELLS: readonly PrintEnvShell[] = ["posix", "powershell", "cmd"];

/** PowerShell on Windows, a POSIX shell everywhere else. */
export function defaultPrintEnvShell(platform: NodeJS.Platform): PrintEnvShell {
  return platform === "win32" ? "powershell" : "posix";
}

export function parsePrintEnvShell(value: string): PrintEnvShell | null {
  const v = value.trim().toLowerCase();
  if (v === "posix" || v === "sh" || v === "bash" || v === "zsh") return "posix";
  if (v === "powershell" || v === "pwsh") return "powershell";
  if (v === "cmd") return "cmd";
  return null;
}

/** sh/bash/zsh: bare when safe, else single quotes with `'\''` for a quote. */
export function posixQuote(value: string): string {
  return /^[\w@%+=:,./-]*$/.test(value) && value !== "" ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * PowerShell literal string: single quotes, a quote inside doubled.
 * Nothing expands in it. Bare only for plain words: `,` builds an array,
 * a leading `@` splats, and a bare `--` is eaten by the parser.
 */
export function powershellQuote(value: string): string {
  return /^[\w+=:./\\-]+$/.test(value) && value !== "--" ? value : `'${value.replace(/'/g, "''")}'`;
}

/**
 * cmd: `set "NAME=value"`. cmd toggles its quote state at every `"`, so
 * the characters it treats as operators (`& | < > ^ ( )`) get a `^` only
 * where they fall outside a quoted stretch. `%` cannot be escaped when
 * typed at the prompt; none of the launch variables hold one.
 */
function cmdSet(name: string, value: string): string {
  let inQuote = true;
  let out = "";
  for (const ch of value) {
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && "&|<>^()".includes(ch)) out += "^";
    out += ch;
  }
  return `set "${name}=${out}"`;
}

/** A Windows command-line argument (CommandLineToArgvW rules): quotes only when needed. */
export function windowsArgQuote(value: string): string {
  if (value !== "" && !/[\s"&|<>^()%!]/.test(value)) return value;
  let out = '"';
  let slashes = 0;
  for (const ch of value) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    out += ch === '"' ? "\\".repeat(slashes * 2 + 1) : "\\".repeat(slashes);
    slashes = 0;
    out += ch;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

export function formatEnvLine(shell: PrintEnvShell, name: string, value: string): string {
  if (shell === "powershell") return `$env:${name} = '${value.replace(/'/g, "''")}'`;
  if (shell === "cmd") return cmdSet(name, value);
  return `export ${name}=${posixQuote(value)}`;
}

/** The command line; PowerShell needs `&` to run a quoted program path. */
export function formatCommandLine(shell: PrintEnvShell, binary: string, args: readonly string[]): string {
  if (shell === "powershell") {
    const program = powershellQuote(binary);
    const head = program.startsWith("'") || binary.startsWith("-") ? `& ${program}` : program;
    return [head, ...args.map(powershellQuote)].join(" ");
  }
  if (shell === "cmd") return [binary, ...args].map(windowsArgQuote).join(" ");
  return [binary, ...args].map(posixQuote).join(" ");
}
