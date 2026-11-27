import { homedir } from "node:os";
import {
  mayNameSensitiveHomeEntry,
  mentionsSensitiveHomeEntry,
  sensitiveTreeTargets,
  sensitiveWriteTargets,
} from "../fs/sensitive-write-targets.js";
import { liftSubstitutions } from "../shell-command-guard/command-substitution.js";
import type { ShellDialect } from "../shell-command-guard/shell-line-lexer.js";
import {
  execWriteAnalysis,
  shellWriteAnalysis,
  type WriteAnalysis,
} from "../shell-command-guard/write-targets.js";

/**
 * The sensitive home writes a shell line may make, failing closed
 * (review round 2 of ATO-2505). Beyond the literal targets: a write
 * target the shell only spells out when it runs (`tee -a ~/.zsh?c`,
 * `cp x ~/.{zsh,bash}rc`, `cp p ~/Library/Launch?gents/`), any dynamic
 * word of a command not modelled (`python3 -c "…$HOME/.bashrc…"`), an
 * archive unpacked into home or above an entry (`tar xzf p.tgz -C ~`,
 * `cd ~ && unzip x.zip`), `git config --global|--system|--file`, a
 * crontab or login job. Command substitutions are lifted out and read
 * as lines of their own, so `echo $(date) && cat ~/.gitconfig` reads as
 * the reader it is.
 *
 * `unreadable` when a part of the line cannot be read at all (an open
 * quote, a `${…}` form the lexer refuses) and that part names a
 * sensitive entry: the caller asks, with a reason that does not claim a
 * write.
 */
export interface LineSensitiveWrites {
  writes: string[];
  unreadable: boolean;
}

/** How deep `$(… $(…) …)` is read. */
const MAX_DEPTH = 4;

/** `${X}`, `${X:-~/.bashrc}`: a variable, its value only known when it runs. */
const BRACED_VARIABLE = /\$\{(?!HOME\})[^}]*\}/g;

export function sensitiveLineWrites(
  line: string,
  cwd: string,
  dialect: ShellDialect,
  homeDir: string = homedir(),
): LineSensitiveWrites {
  const namesOne = mentionsSensitiveHomeEntry(line);
  const found: LineSensitiveWrites = { writes: [], unreadable: false };
  const visit = (piece: string, depth: number): void => {
    if (dialect !== "posix") {
      record(shellWriteAnalysis(piece, cwd, dialect), piece);
      return;
    }
    const lifted = depth < MAX_DEPTH ? liftSubstitutions(piece) : null;
    if (lifted === null) {
      record(null, piece);
      return;
    }
    record(shellWriteAnalysis(lifted.outer.replace(BRACED_VARIABLE, "$__braced__"), cwd, dialect), piece);
    for (const inner of lifted.inner) visit(inner, depth + 1);
  };
  const record = (analysis: WriteAnalysis | null, piece: string): void => {
    if (analysis === null) {
      if (mentionsSensitiveHomeEntry(piece)) found.unreadable = true;
      return;
    }
    found.writes.push(...sensitiveAnalysisWrites(analysis, cwd, namesOne, homeDir));
  };
  visit(line, 0);
  found.writes = [...new Set(found.writes)];
  return found;
}

/** `sensitiveLineWrites` for a direct exec that is not a shell (`{cmd:"tar", args:[…]}`). */
export function sensitiveExecWrites(
  cmd: string,
  args: readonly string[],
  cwd: string,
  homeDir: string = homedir(),
): string[] {
  const analysis = execWriteAnalysis(cmd, args, cwd);
  if (analysis === null) return [];
  const namesOne = [cmd, ...args].some((arg) => mentionsSensitiveHomeEntry(arg));
  return [...new Set(sensitiveAnalysisWrites(analysis, cwd, namesOne, homeDir))];
}

function sensitiveAnalysisWrites(
  analysis: WriteAnalysis,
  cwd: string,
  namesOne: boolean,
  homeDir: string,
): string[] {
  const maybe = (word: { text: string; dir: string | undefined }): boolean =>
    mayNameSensitiveHomeEntry(word.text, word.dir, namesOne, homeDir);
  return [
    ...sensitiveWriteTargets(analysis.targets, cwd, homeDir),
    ...sensitiveTreeTargets(analysis.trees, homeDir),
    ...analysis.other,
    ...analysis.unresolved.filter(maybe).map((word) => word.text),
    ...analysis.opaque.filter(maybe).map((word) => word.text),
  ];
}
