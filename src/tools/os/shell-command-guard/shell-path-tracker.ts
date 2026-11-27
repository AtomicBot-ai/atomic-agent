import { homedir } from "node:os";
import { posix } from "node:path";
import { programName } from "./command-segments.js";

/**
 * Where a relative path on a command line points (ATO-2126 review).
 * `cd ~/.ssh && cat id_rsa` reads `~/.ssh/id_rsa` although no word on
 * the line names it, so the credential rule walks the simple commands
 * in order and keeps the folder the last `cd` / `pushd` moved to.
 *
 * Best effort, and on the strict side: a `cd` inside a pipeline or a
 * subshell is taken as if it ran in the main shell. A target the guard
 * cannot read (`cd -`, a glob, an unknown variable) makes the folder
 * unknown, and relative operands after it resolve to nothing.
 *
 * Variables set on the line are kept too (`K=~/.ssh; cat $K/id_rsa`):
 * a plain `NAME=value` or `export NAME=value` command. `$HOME` is the
 * home folder; any other variable stays as written.
 */

const CD_PROGRAMS: ReadonlySet<string> = new Set(["cd", "pushd"]);
const DECLARERS: ReadonlySet<string> = new Set(["export", "local", "declare", "typeset", "readonly"]);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const VARIABLE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
const UNREADABLE = /[*?[\]{}`]|\$/;

/** What one `cd` did. */
export interface CdStep {
  /** The absolute folder it moved to; `null` when it cannot be read. */
  target: string | null;
  /** The same path with any glob or unknown variable left in, if any. */
  path: string | null;
  /** The word as written, for the finding's reason. */
  word: string;
}

export class ShellPathTracker {
  private dir: string | null;
  private readonly vars = new Map<string, string>();

  constructor(
    cwd: string,
    private readonly home: string = homedir(),
  ) {
    this.dir = cwd.length > 0 ? posix.normalize(cwd) : null;
  }

  /**
   * Read one simple command. A `cd` / `pushd` moves the tracked folder
   * and is returned; an assignment is remembered; anything else leaves
   * both and returns `null`.
   */
  step(words: readonly string[]): CdStep | null {
    this.remember(words);
    const at = words.findIndex((word) => CD_PROGRAMS.has(programName(word)));
    if (at === -1) return null;
    const operand = words.slice(at + 1).find((word) => word === "-" || !word.startsWith("-"));
    const word = operand ?? "~";
    const path = word === "-" ? null : this.absolute(word);
    const target = path === null || UNREADABLE.test(path) ? null : path;
    this.dir = target;
    return { target, path, word };
  }

  /** `~` / `$HOME` at the start and every known `$NAME` replaced. */
  expand(word: string): string {
    const home = word.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, this.home);
    return home.replace(VARIABLE, (whole, braced?: string, bare?: string) => {
      const name = braced ?? bare ?? "";
      if (name === "HOME") return this.home;
      return this.vars.get(name) ?? whole;
    });
  }

  /**
   * The absolute path a path word names, globs and unknown variables
   * left in; `null` when the folder it is relative to is unknown or the
   * word starts with an unknown variable.
   */
  absolute(word: string): string | null {
    const expanded = this.expand(word);
    if (expanded.startsWith("/")) return posix.normalize(expanded);
    if (this.dir === null || expanded.startsWith("$")) return null;
    return posix.join(this.dir, expanded);
  }

  /** `absolute`, or `null` when the path still holds a glob or variable. */
  resolve(word: string): string | null {
    const path = this.absolute(word);
    return path === null || UNREADABLE.test(path) ? null : path;
  }

  private remember(words: readonly string[]): void {
    let at = 0;
    if (words[0] !== undefined && DECLARERS.has(words[0])) at = 1;
    for (; at < words.length; at += 1) {
      const match = ASSIGNMENT.exec(words[at]!);
      if (match === null) return;
      this.vars.set(match[1]!, this.expand(match[2]!));
    }
  }
}
