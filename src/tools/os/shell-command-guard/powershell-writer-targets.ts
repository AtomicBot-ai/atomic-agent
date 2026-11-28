import type { ShellWord } from "./shell-line-lexer.js";

/**
 * The files a PowerShell content writer may write (review round 3 of
 * ATO-2505): `Set-Content` / `sc`, `Add-Content` / `ac`, `Out-File`,
 * `Tee-Object`, `Clear-Content`. Their path can come after switches
 * (`Out-File -Append $HOME\.ssh\authorized_keys`) or as `-Path:x`, so,
 * failing closed, every word that is not a known switch or the value of
 * a known non-path parameter (`-Value`, `-Encoding`, ...) counts, and so
 * does the value of any other parameter. `$PROFILE` among them is a
 * startup file (`HOME_VARIABLE` in `sensitive-write-targets.ts`).
 */
export const POWERSHELL_WRITERS: ReadonlySet<string> = new Set([
  "set-content", "sc", "add-content", "ac", "out-file", "tee-object", "clear-content",
]);

const SWITCHES: ReadonlySet<string> = new Set([
  "-append", "-force", "-noclobber", "-nonewline", "-passthru", "-whatif", "-confirm", "-asbytestream",
]);
const NON_PATH_VALUES: ReadonlySet<string> = new Set([
  "-value", "-encoding", "-inputobject", "-stream", "-delimiter", "-width", "-filter", "-include",
  "-exclude", "-credential", "-variable",
]);

export function powershellWriterTargets(args: readonly ShellWord[]): ShellWord[] {
  const found: ShellWord[] = [];
  for (let k = 0; k < args.length; k++) {
    const word = args[k]!;
    const named = /^(-[a-z]+)(?::(.*))?$/i.exec(word.text);
    if (named === null) {
      found.push(word);
      continue;
    }
    const flag = named[1]!.toLowerCase();
    if (SWITCHES.has(flag)) continue;
    const inline = named[2];
    if (inline !== undefined && inline.length > 0) {
      if (!NON_PATH_VALUES.has(flag)) found.push({ ...word, text: inline });
      continue;
    }
    const value = args[(k += 1)];
    if (value !== undefined && !NON_PATH_VALUES.has(flag)) found.push(value);
  }
  return found;
}
