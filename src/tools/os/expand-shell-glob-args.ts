import { globSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolveUserPath } from "./expand-home.js";
import { basenameCommand } from "./shell-command-guard/normalise.js";

const MAX_GLOB_MATCHES = 10_000;

/** Commands where a bare `*.ext` (no `/`) in argv is treated as a cwd-relative glob. */
const RELATIVE_GLOB_CMDS = new Set([
  "rm",
  "cp",
  "mv",
  "chmod",
  "chown",
  "touch",
  "ls",
  "unlink",
  "rmdir",
]);

/**
 * Interpreters whose `-c` argument is a program, not a path. The payload
 * routinely carries `?`/`*` (regexes, URLs with query strings, glob patterns
 * meant for the inner program) and must reach the interpreter verbatim.
 * `node`, `perl` and `ruby` are deliberately absent: their `-c` is a
 * syntax check that takes a file path, so globbing it stays correct.
 */
const CODE_PAYLOAD_CMDS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "python",
  "python3",
]);

/** Matches with the guard's view of the binary: basename, case-folded. */
function isCodePayloadCmd(cmd: string): boolean {
  const bin = basenameCommand(cmd).toLowerCase().replace(/\.exe$/, "");
  if (CODE_PAYLOAD_CMDS.has(bin)) return true;
  return /^python\d+(\.\d+)*$/.test(bin);
}

/** `-c`, a short-option cluster ending in it (`-lc`, `-ec`), or the long form. */
function isCodePayloadFlag(arg: string): boolean {
  return /^-[a-zA-Z]*c$/.test(arg) || arg === "--command";
}

/**
 * `scheme://…` — a URL is never a filesystem glob, even with `?` and `/`.
 * Two-letter minimum keeps Windows `C://…` sloppy-paths out of the rule.
 */
const URL_RE = /^[a-z][a-z0-9+.-]+:\/\//i;

function hasGlobMetachar(arg: string): boolean {
  return /[*?]/.test(arg);
}

function isUrlLike(arg: string): boolean {
  return URL_RE.test(arg);
}

/**
 * Indices of argv entries that are code payloads rather than paths — the
 * token right after a `-c` (or a cluster like `-lc`) for a known
 * interpreter. `bash -c '<program>'` is the dominant shape; the scan
 * stops at the first non-flag token so a later positional argument is not
 * mistaken for a payload. A flag that takes a separate value (`-o
 * pipefail`, `-X utf8`) ends the scan early — a known limit, and safe:
 * the never-drop rule below keeps such a payload intact unless it
 * collides with a really-matching file glob.
 */
function codePayloadIndices(cmd: string, args: string[]): ReadonlySet<number> {
  const marked = new Set<number>();
  if (!isCodePayloadCmd(cmd)) return marked;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (isCodePayloadFlag(arg)) {
      if (i + 1 < args.length) marked.add(i + 1);
      break;
    }
    if (!arg.startsWith("-")) break;
  }
  return marked;
}

function shouldExpandGlobArg(cmd: string, arg: string): boolean {
  if (!hasGlobMetachar(arg)) return false;
  if (arg.startsWith("-")) return false;
  if (isUrlLike(arg)) return false;
  if (
    arg.startsWith("/") ||
    arg.startsWith("~/") ||
    arg.startsWith("./") ||
    arg.startsWith("../")
  ) {
    return true;
  }
  if (/[/\\]/.test(arg)) return true;
  return RELATIVE_GLOB_CMDS.has(cmd);
}

function globMatches(pattern: string, cwd: string): string[] {
  const matches = globSync(pattern, {
    cwd: isAbsolute(pattern) ? undefined : cwd,
  });
  return matches.slice(0, MAX_GLOB_MATCHES);
}

/**
 * Expands `*` / `?` in argv the way a shell would for typical file commands,
 * before `spawn` (which does not perform glob expansion).
 *
 * An argument is never dropped. A pattern that matches nothing passes through
 * verbatim, which is what POSIX shells do by default (bash without
 * `nullglob`, zsh with `nomatch` off) — silently discarding it turned a
 * correct `bash -c '<program>'` into a bare `bash -c` and made the shell
 * fail with "option requires an argument".
 */
export function expandShellGlobArgs(
  cmd: string,
  args: string[],
  cwd: string,
): string[] {
  const codePayloads = codePayloadIndices(cmd, args);
  const out: string[] = [];
  for (const [index, arg] of args.entries()) {
    if (codePayloads.has(index) || !shouldExpandGlobArg(cmd, arg)) {
      out.push(arg);
      continue;
    }
    const pattern = arg.startsWith("~") ? resolveUserPath(arg, cwd) : arg;
    const resolvedPattern = isAbsolute(pattern)
      ? pattern
      : resolveUserPath(pattern, cwd);
    let matches: string[];
    try {
      matches = globMatches(resolvedPattern, cwd);
    } catch {
      out.push(arg);
      continue;
    }
    if (matches.length === 0) {
      out.push(arg);
      continue;
    }
    out.push(...matches);
  }
  return out;
}
