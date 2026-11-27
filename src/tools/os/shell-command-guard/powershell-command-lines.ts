import type { NormalisedCommand } from "./guard-types.js";
import { normaliseCommand } from "./normalise.js";
import { programName, splitCommandSegments } from "./command-segments.js";

/**
 * The command line `powershell -Command "<line>"` / `pwsh -c '<line>'`
 * runs (ATO-2728, review round 1). The quoted line is one word for the
 * POSIX credential rule, so `pwsh -c "cd ~; gc .ssh/id_rsa"` never reached
 * its `cd` tracking or its readers. Each line comes back normalised the
 * way the shell tool hands a command line to the guard (whitespace
 * tokens), for the argument rules to read again.
 *
 * PowerShell's own options before the command are skipped, with their
 * value when they take one (`-ExecutionPolicy Bypass`, `-w hidden`).
 * `-Command` takes every word after it, and so does any prefix of it
 * (`-c`, `-com`) and `-CommandWithArgs` / `-cwa`. `-File` and
 * `-EncodedCommand` stop the scan: a script file is not read here, and an
 * encoded command is `rules-encoded-exec-windows.ts`'s. Windows
 * PowerShell 5.1 reads a bare first word as the command; pwsh 7 reads it
 * as a script file.
 */

const PROGRAMS: ReadonlySet<string> = new Set(["powershell", "pwsh"]);
/** Options whose value is the next word, as PowerShell spells them or their aliases. */
const VALUE_OPTIONS: readonly string[] = [
  "executionpolicy",
  "windowstyle",
  "outputformat",
  "inputformat",
  "configurationname",
  "configurationfile",
  "workingdirectory",
  "settingsfile",
  "psconsolefile",
  "version",
  "custompipename",
];
const VALUE_ALIASES: ReadonlySet<string> = new Set(["ep", "ex", "w", "o", "of", "if", "wd", "v"]);

const isPrefix = (flag: string, name: string, min: number): boolean =>
  flag.length >= min && name.startsWith(flag);

function takesValue(flag: string): boolean {
  return VALUE_ALIASES.has(flag) || VALUE_OPTIONS.some((name) => isPrefix(flag, name, 2));
}

/** The script after a `powershell` / `pwsh` program word, or null. */
function scriptAfter(args: readonly string[], program: string): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i]!;
    // `-`, `/`, and the dashes PowerShell's own parser takes for `-`.
    const option = /^[-/\u2013\u2014\u2015](.+)$/.exec(word);
    if (option === null) {
      return program === "powershell" ? args.slice(i).join(" ") : null;
    }
    const colon = option[1]!.indexOf(":");
    const flag = (colon === -1 ? option[1]! : option[1]!.slice(0, colon)).toLowerCase();
    const value = colon === -1 ? undefined : option[1]!.slice(colon + 1);
    if (isPrefix(flag, "command", 1) || flag === "cwa" || isPrefix(flag, "commandwithargs", 8)) {
      const script = value === undefined ? args.slice(i + 1) : [value, ...args.slice(i + 1)];
      return script.length === 0 ? null : script.join(" ");
    }
    if (isPrefix(flag, "file", 1) || flag === "ec" || isPrefix(flag, "encodedcommand", 1)) return null;
    if (value === undefined && takesValue(flag)) i += 1;
  }
  return null;
}

/** The scripts the `powershell` / `pwsh` calls in one simple command run. */
export function powershellScripts(words: readonly string[]): string[] {
  const scripts: string[] = [];
  words.forEach((word, index) => {
    const program = programName(word);
    if (!PROGRAMS.has(program)) return;
    const script = scriptAfter(words.slice(index + 1), program);
    if (script !== null) scripts.push(script);
  });
  return scripts;
}

export function powershellCommandLines(input: NormalisedCommand, cwd: string): NormalisedCommand[] {
  const commands: NormalisedCommand[] = [];
  for (const words of splitCommandSegments(input.joined)) {
    for (const line of powershellScripts(words)) {
      const tokens = line.split(/\s+/).filter((token) => token.length > 0);
      if (tokens.length === 0) continue;
      commands.push(normaliseCommand({ cmd: tokens[0]!, rawArgs: tokens.slice(1), cwd }));
    }
  }
  return commands;
}
