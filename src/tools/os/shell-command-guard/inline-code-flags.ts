import { programName } from "./command-segments.js";

/**
 * Interpreters and the flag that hands them code on the command line,
 * shared by the literal-path check (`rules-credentials.ts`) and the
 * home-folder code check (`rules-inline-home-code.ts`).
 *
 * The code may be its own word (`python3 -c "..."`, `perl -ne '...'`) or
 * stuck to the flag (`python3 -c"..."`, `perl -e'...'`, `node -e"..."`,
 * `ruby -e'...'`), which every one of these interpreters accepts (ATO-2730,
 * review round 1). Python's `-W` and `-X` take a value, so a `c` after
 * them (`-Xtracemalloc`) is not the code flag.
 */
const INLINE_CODE_FLAGS: readonly (readonly [RegExp, RegExp])[] = [
  [/^python[0-9.]*$|^py$/, /^-[a-zA-VYZ]*c/],
  [/^node$|^bun$/, /^(?:-[a-z]*[ep]$|-[ep].|--eval(?:=|$)|--print(?:=|$))/],
  [/^deno$/, /^eval$/],
  [/^perl$/, /^-[a-zA-Z]*[eE]/],
  [/^ruby$/, /^-[a-zA-Z]*e/],
  [/^php$/, /^-[a-z]*r/],
];

/** The word at `index` is an interpreter handed code on this simple command. */
export function runsInlineCodeAt(words: readonly string[], index: number): boolean {
  const program = programName(words[index] ?? "");
  const flag = INLINE_CODE_FLAGS.find(([name]) => name.test(program))?.[1];
  return flag !== undefined && words.slice(index + 1).some((arg) => flag.test(arg));
}
