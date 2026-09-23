import { globSync } from "node:fs";
import { isAbsolute } from "node:path";
import { basenameCommand } from "./shell-command-guard/normalise.js";

/**
 * `node --check a.js b.js c.js` checks `a.js` and ignores the rest.
 *
 * That is node's own contract — `--check` takes one script, extra
 * positionals are its `argv` — and it is how a run replied "ran
 * node --check on all JavaScript files (all passed)" after one file was
 * checked, and the next attempt reported "Syntax: all passed" from the
 * same one-file check. Nothing in the output says so: exit 0, no text.
 *
 * So the shell tool says it. A command line that runs `node --check` /
 * `node -c` over more than one path gets this line prepended to its
 * result, naming the one file that was checked. Globs are expanded here
 * the way the subshell expands them, because on the subshell path the
 * tool never sees the expanded argv (`node --check js/*.js` is handed to
 * `sh -c` as written).
 */

/** Hard cap on glob matches counted, same order as the shell tool's own. */
const MAX_GLOB_MATCHES = 10_000;

/** Command-line separators; each segment is one command. */
const SEGMENT_RE = /\s*(?:&&|\|\||;|\|)\s*/;

function isNode(token: string): boolean {
  const bin = basenameCommand(token)
    .toLowerCase()
    .replace(/\.exe$/, "");
  return bin === "node" || bin === "nodejs";
}

function isCheckFlag(token: string): boolean {
  return token === "--check" || token === "-c";
}

/** Strip one layer of matching quotes — the shapes models emit. */
function unquote(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return token.slice(1, -1);
    }
  }
  return token;
}

function expand(pattern: string, cwd: string): string[] {
  if (!/[*?]/.test(pattern)) return [pattern];
  try {
    const matches = globSync(pattern, {
      cwd: isAbsolute(pattern) ? undefined : cwd,
    }).slice(0, MAX_GLOB_MATCHES);
    // A pattern that matches nothing passes through verbatim — what a
    // POSIX shell does without `nullglob`, and what node then sees.
    return matches.length > 0 ? matches.sort() : [pattern];
  } catch {
    return [pattern];
  }
}

/**
 * The paths a `node --check` in `commandLine` would be given, in the
 * order node sees them — or `null` when the line runs no such check.
 * Only the first `node --check` segment is read: one notice per call.
 */
export function nodeCheckPaths(
  commandLine: string,
  cwd: string,
): string[] | null {
  for (const segment of commandLine.split(SEGMENT_RE)) {
    const tokens = segment
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map(unquote);
    if (tokens.length === 0 || !isNode(tokens[0]!)) continue;
    const flagIdx = tokens.findIndex((t, i) => i > 0 && isCheckFlag(t));
    if (flagIdx === -1) continue;
    const paths: string[] = [];
    for (const token of tokens.slice(flagIdx + 1)) {
      if (token.startsWith("-")) continue;
      paths.push(...expand(token, cwd));
    }
    return paths;
  }
  return null;
}

/**
 * The line prepended to an `os.shell.run` result whose command ran
 * `node --check` over several paths; `null` when it did not.
 */
export function nodeCheckMultiFileNotice(
  commandLine: string,
  cwd: string,
): string | null {
  const paths = nodeCheckPaths(commandLine, cwd);
  if (paths === null || paths.length < 2) return null;
  return `node --check checks only the first file (${paths[0]}); run one command per file — the other ${paths.length - 1} path${paths.length === 2 ? " was" : "s were"} not checked`;
}
