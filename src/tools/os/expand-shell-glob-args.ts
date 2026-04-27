import { globSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolveUserPath } from "./expand-home.js";

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

function hasGlobMetachar(arg: string): boolean {
  return /[*?]/.test(arg);
}

function shouldExpandGlobArg(cmd: string, arg: string): boolean {
  if (!hasGlobMetachar(arg)) return false;
  if (arg.startsWith("-")) return false;
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
 */
export function expandShellGlobArgs(
  cmd: string,
  args: string[],
  cwd: string,
): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (!shouldExpandGlobArg(cmd, arg)) {
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
      continue;
    }
    out.push(...matches);
  }
  return out;
}
