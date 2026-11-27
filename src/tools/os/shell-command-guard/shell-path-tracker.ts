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
 */

const CD_PROGRAMS: ReadonlySet<string> = new Set(["cd", "pushd"]);
const UNREADABLE = /[*?[\]{}`]|\$/;

/** What one `cd` did. */
export interface CdStep {
  /** The absolute folder it moved to; `null` when it cannot be read. */
  target: string | null;
  /** The word as written, for the finding's reason. */
  word: string;
}

export class ShellPathTracker {
  private dir: string | null;

  constructor(
    cwd: string,
    private readonly home: string = homedir(),
  ) {
    this.dir = cwd.length > 0 ? posix.normalize(cwd) : null;
  }

  /**
   * Read one simple command. A `cd` / `pushd` moves the tracked folder
   * and is returned; anything else leaves it and returns `null`.
   */
  step(words: readonly string[]): CdStep | null {
    const at = words.findIndex((word) => CD_PROGRAMS.has(programName(word)));
    if (at === -1) return null;
    const operand = words.slice(at + 1).find((word) => word === "-" || !word.startsWith("-"));
    const word = operand ?? "~";
    const target = word === "-" ? null : this.resolve(word);
    this.dir = target;
    return { target, word };
  }

  /** `~`, `$HOME` and `${HOME}` at the start replaced by the home folder. */
  expandHome(word: string): string {
    return word.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, this.home);
  }

  /**
   * The absolute path a path word names, or `null` when the guard cannot
   * tell (an unknown folder, a glob, a variable).
   */
  resolve(word: string): string | null {
    const expanded = this.expandHome(word);
    if (UNREADABLE.test(expanded)) return null;
    if (expanded.startsWith("/")) return posix.normalize(expanded);
    if (this.dir === null) return null;
    return posix.resolve(this.dir, expanded);
  }
}
