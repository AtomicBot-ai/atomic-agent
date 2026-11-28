import type { NormalisedCommand } from "./guard-types.js";
import type { ArgScanFinding } from "./arg-scan-finding.js";

/**
 * `dangerous.encoded_exec` for PowerShell (ATO-2728). The POSIX rule
 * (`rules-encoded-exec.ts`) knows `base64 -d | sh`; on Windows the same
 * hidden program is `powershell -EncodedCommand <base64>` or
 * `iex ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(...)))`.
 * Both used to run unasked in bypass.
 *
 * Read from the lowercased joined line:
 *  - `powershell` / `pwsh` with `-EncodedCommand` or any prefix of it
 *    PowerShell accepts (`-e`, `-en`, `-enc`, ...), or its `-ec` alias,
 *    with `-` or `/`. `-ExecutionPolicy` (`-ex`, `-ep`) is not one;
 *  - `FromBase64String` together with something that runs a string:
 *    `iex` / `Invoke-Expression`, `[ScriptBlock]::Create`, `& (...)`,
 *    `.Invoke(`, `Start-Process` / `saps` with `-ArgumentList`, or
 *    `powershell -Command` / `-c`.
 *
 * cmd.exe drops `^` and the quotes before PowerShell sees its arguments,
 * and PowerShell takes en dash, em dash and horizontal bar for `-`, so
 * `"C:\Program Files\PowerShell\7\pwsh.exe" -enc`, `pwsh "-enc"`, `pwsh
 * -e^nc` and `pwsh \u2013enc` are read as the plain form (review round 1).
 */

/** A `powershell` / `pwsh` program word; the rest of its command follows. */
const POWERSHELL = /(?:^|[\s;&|(])(?:\S*[/\\])?(?:powershell|pwsh)(?:\.exe)?(?=\s)([^;&|\n]*)/g;
/** An option word: `-enc`, `/enc`, `-ec:`. */
const OPTION = /\s[-/]([a-z]+)(?=\s|:|$)/g;
const FROM_BASE64 = /\bfrombase64string\s*\(/;
const RUNS_STRING =
  /(?:^|[\s;&|(])(?:iex|invoke-expression)\b|\[scriptblock\]::create|(?:^|[\s;(|])&\s*\(|\.invoke\s*\(|\b(?:start-process|saps)\b[^;|&\n]*-a(?:rg(?:umentlist)?)?\b|\b(?:powershell|pwsh)(?:\.exe)?\s+(?:-\S+\s+)*[-/](?:c|command)\b/;

const ENCODED_COMMAND = "encodedcommand";

/** `-e`, `-enc`, `-EncodedCommand`, `-ec`: PowerShell takes any unique prefix. */
function isEncodedFlag(flag: string): boolean {
  return flag === "ec" || (flag.length >= 1 && ENCODED_COMMAND.startsWith(flag));
}

/** PowerShell's own options: those after `-Command` or `-File` belong to the script. */
function ownFlags(rest: string): string[] {
  const flags: string[] = [];
  for (const option of rest.matchAll(OPTION)) {
    const flag = option[1]!;
    if ("command".startsWith(flag) || "file".startsWith(flag)) break;
    flags.push(flag);
  }
  return flags;
}

/** The line as PowerShell receives it: no `^`, no quotes, dash look-alikes as `-`. */
function asPowerShellSees(line: string): string {
  return line.replace(/[\^"']/g, "").replace(/[\u2013\u2014\u2015]/g, "-");
}

export function matchWindowsEncodedExec(input: NormalisedCommand): ArgScanFinding | null {
  const line = asPowerShellSees(input.joinedLower);
  for (const call of line.matchAll(POWERSHELL)) {
    if (ownFlags(call[1]!).some(isEncodedFlag)) {
      return {
        id: "dangerous.encoded_exec",
        reason: "run a PowerShell command given as base64 (-EncodedCommand)",
        confidence: 1,
      };
    }
  }
  if (FROM_BASE64.test(line) && RUNS_STRING.test(line)) {
    return {
      id: "dangerous.encoded_exec",
      reason: "decode a base64 string and run it in PowerShell",
      confidence: 0.9,
    };
  }
  return null;
}
