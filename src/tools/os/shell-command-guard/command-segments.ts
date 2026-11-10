import { basenameCommand } from "./normalise.js";
import { lexShellLine } from "./shell-line-lexer.js";

/**
 * Split the guard's joined command line into simple commands, each a
 * list of words. `&&`, `||`, `;`, `|`, `&`, newlines and parentheses
 * (subshells, process substitution) end a command; redirects and the
 * word they apply to are dropped. Quotes come off, so `git push
 * "--force"` reads the same as the bare flag.
 *
 * The shell lexer does the work when it can read the line. When it
 * cannot (command substitution, backticks, an unbalanced quote) a plain
 * split on the same operators is used instead, so a rule still sees
 * every word: the guard must not go quiet because a line is hard to
 * parse.
 *
 * Case is kept: `git branch -D` and `-d` differ.
 */
export function splitCommandSegments(line: string): string[][] {
  const tokens = lexShellLine(line, "posix");
  if (tokens === null) return fallbackSegments(line);
  const segments: string[][] = [];
  let current: string[] = [];
  let skipNextWord = false;
  const flush = (): void => {
    if (current.length > 0) segments.push(current);
    current = [];
  };
  for (const token of tokens) {
    if (token.kind === "word") {
      if (skipNextWord) {
        skipNextWord = false;
        continue;
      }
      current.push(token.text);
      continue;
    }
    if (token.kind === "redirect") {
      skipNextWord = true;
      continue;
    }
    // separator, open, close
    skipNextWord = false;
    flush();
  }
  flush();
  return segments;
}

const FALLBACK_SEPARATORS = /&&|\|\||[;|&\n()`]|\$\(/;

function fallbackSegments(line: string): string[][] {
  return line
    .split(FALLBACK_SEPARATORS)
    .map((segment) =>
      segment
        .split(/\s+/)
        .map(stripQuotes)
        .filter((word) => word.length > 0),
    )
    .filter((words) => words.length > 0);
}

function stripQuotes(word: string): string {
  return word.replace(/^["']+|["']+$/g, "");
}

/**
 * Lowercased program name of a word as the OS would resolve it:
 * directory and a Windows `.exe` suffix dropped, so `/usr/bin/git` and
 * `git.exe` both read as `git`.
 */
export function programName(word: string): string {
  return basenameCommand(word).toLowerCase().replace(/\.exe$/, "");
}

/**
 * For every occurrence of `program` in every segment, the words after
 * it. Wrappers in front (`sudo`, `env X=1`, `xargs`, `time`) are
 * covered because the program is looked for anywhere in the segment,
 * the way the older whole-line patterns matched it.
 */
export function invocationsOf(
  segments: readonly (readonly string[])[],
  program: string,
): (readonly string[])[] {
  const found: (readonly string[])[] = [];
  for (const words of segments) {
    words.forEach((word, index) => {
      if (programName(word) === program) found.push(words.slice(index + 1));
    });
  }
  return found;
}

/**
 * Letters of a bundled short-option word (`-fu` → `f`, `u`), stopping
 * at the first letter in `valueLetters`: everything after it is that
 * option's value (`git clean -fe pattern` vs `-efoo`). `null` for a
 * word that is not a short-option bundle (`--long`, `-`, `+ref`, `.`).
 */
export function shortOptionLetters(
  word: string,
  valueLetters = "",
): string[] | null {
  if (!/^-[A-Za-z0-9]/.test(word) || word.startsWith("--")) return null;
  const letters: string[] = [];
  for (const letter of word.slice(1)) {
    letters.push(letter);
    if (valueLetters.includes(letter)) break;
  }
  return letters;
}

/**
 * Whether `word` names the long option `name`, either exactly, as
 * `name=value`, or as an abbreviation of at least `minLength`
 * characters: git and GNU getopt both accept an unambiguous prefix
 * (`git reset --har`, `chmod --rec`).
 */
export function isLongOption(
  word: string,
  name: string,
  minLength = name.length,
): boolean {
  if (word === name || word.startsWith(`${name}=`)) return true;
  return word.length >= minLength && name.startsWith(word);
}

/** Shells whose `-c` runs the next word as a command line. */
export const NESTED_SHELL_PROGRAMS: readonly string[] = ["bash", "sh", "zsh", "dash", "ksh"];

export interface NestedShellOptions {
  /** `-c` (alone or bundled, `-lc`, `-ec`) or `--command` was given. */
  runsCommand: boolean;
  /**
   * The command line it runs: the first word after the options, or the
   * value of `--command=…`. Undefined when there is none.
   */
  script?: string;
}

/**
 * Read the options of a nested shell, `args` being the words after the
 * program (`bash -lc 'cd x && rm y'` → `-lc`, `cd x && rm y`). Only the
 * options before the first operand count: `bash run.sh -c` passes `-c`
 * to the script.
 */
export function scanNestedShellOptions(args: readonly string[]): NestedShellOptions {
  let runsCommand = false;
  let inline: string | undefined;
  let i = 0;
  for (; i < args.length; i += 1) {
    const word = args[i] ?? "";
    if (word === "--") {
      i += 1;
      break;
    }
    if (!word.startsWith("-") || word === "-") break;
    if (isLongOption(word, "--command")) {
      runsCommand = true;
      if (word.startsWith("--command=")) inline = word.slice("--command=".length);
      continue;
    }
    if (word === "--rcfile" || word === "--init-file") {
      i += 1;
      continue;
    }
    const letters = shortOptionLetters(word, "oO");
    if (letters === null) continue;
    if (letters.includes("c")) runsCommand = true;
    // `-o pipefail`: the value is the next word.
    if (letters.at(-1) === "o" || letters.at(-1) === "O") i += 1;
  }
  if (!runsCommand) return { runsCommand };
  const script = inline ?? args[i];
  return script !== undefined ? { runsCommand, script } : { runsCommand };
}
