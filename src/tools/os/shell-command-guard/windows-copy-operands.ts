/**
 * Which words of a copy command are its sources and which is the
 * destination, for `rules-credentials-windows.ts` (ATO-2728, review
 * round 2). PowerShell's `Copy-Item` / `Move-Item` name them as
 * parameters in any order: `Copy-Item -Destination C:\tmp\x -Path
 * $HOME\.ssh\id_rsa` reads the key although the key is the last word.
 *
 * `-Destination` (any prefix from `-de`), `-Path` (from `-pa`),
 * `-LiteralPath` (from `-l`, also `-lp` / `-PSPath`) are read by name,
 * with the value after a space or a `:`. Without them the positional rule
 * holds: the last operand is the destination (`copy`, `xcopy`, `cp`,
 * `scp`), the second one for `robocopy`. With `-Path` named, the first
 * positional word is the destination, as PowerShell binds it. cmd options
 * (`/Y`, `/R:3`) and other PowerShell switches are skipped; a few
 * PowerShell options that take a value skip it too.
 */

import { HOME_ONLY } from "./windows-credential-paths.js";

/** The destination is the last operand, or the second for robocopy. */
export const COPIERS: ReadonlySet<string> = new Set([
  "copy", "xcopy", "copy-item", "cpi", "cp", "move", "move-item", "mi", "mv", "scp", "rsync",
]);
/** Archivers: every operand is something they take in. */
const ARCHIVERS: ReadonlySet<string> = new Set(["compress-archive", "zip", "7z"]);

export interface CopyOperands {
  destination: string | undefined;
  sources: string[];
}

/** Copy-Item / Move-Item options whose value is the next word. */
const VALUE_OPTIONS: readonly string[] = ["filter", "include", "exclude", "credential", "tosession", "fromsession"];

const isPrefix = (flag: string, name: string, min: number): boolean =>
  flag.length >= min && name.startsWith(flag);

type Role = "destination" | "source" | "skip" | "switch";

function roleOf(flag: string): Role {
  if (isPrefix(flag, "destination", 2)) return "destination";
  if (isPrefix(flag, "path", 2) || isPrefix(flag, "literalpath", 1) || flag === "lp" || flag === "pspath") {
    return "source";
  }
  return VALUE_OPTIONS.some((name) => isPrefix(flag, name, 3)) ? "skip" : "switch";
}

/** The operands of the copy program at `words[at]`. */
export function copyOperands(words: readonly string[], at: number, robocopy: boolean): CopyOperands {
  const positional: string[] = [];
  const sources: string[] = [];
  let destination: string | undefined;
  const rest = words.slice(at + 1);
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!;
    const named = /^-([a-z]+)(?::(.*))?$/.exec(word);
    if (named !== null) {
      const role = roleOf(named[1]!);
      if (role === "switch") continue;
      const inline = named[2];
      const value = inline !== undefined && inline.length > 0 ? inline : rest[(i += 1)];
      if (value === undefined || role === "skip") continue;
      if (role === "destination") destination = value;
      else sources.push(value);
      continue;
    }
    // `/Y`, `/R:3` are cmd options; `/c/Users/...`, `/tmp/k` are paths.
    if (/^\/[a-z0-9?]+(?::[^/\\]*)?$/.test(word)) continue;
    positional.push(word);
  }
  if (destination !== undefined) return { destination, sources: [...sources, ...positional] };
  if (sources.length > 0) {
    return { destination: positional[0], sources: [...sources, ...positional.slice(1)] };
  }
  if (positional.length < 2) return { destination: undefined, sources: positional };
  const last = robocopy ? positional[1]! : positional.at(-1)!;
  return { destination: last, sources: positional.filter((word) => word !== last) };
}

/**
 * The home folder itself as what a copy or archive takes in (`robocopy
 * %USERPROFILE% D:\x /E`, `Compress-Archive -Path $HOME`, `cp -r ~ /b`):
 * the credential folders go with it. A copy into the home folder is not.
 */
export function homeFolderCopy(words: readonly string[], programs: readonly string[]): string | undefined {
  const at = programs.findIndex((name) => COPIERS.has(name) || name === "robocopy" || ARCHIVERS.has(name));
  if (at === -1) return undefined;
  const sources = ARCHIVERS.has(programs[at]!)
    ? words.slice(at + 1)
    : copyOperands(words, at, programs[at] === "robocopy").sources;
  return sources.find((word) => HOME_ONLY.test(word));
}
