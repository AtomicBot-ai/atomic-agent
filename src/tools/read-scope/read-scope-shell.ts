import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { resolveUserPath } from "../os/expand-home.js";
import type { ToolContext } from "../tool-registry.js";
import {
  isOutsideReadRoots,
  isScratchPath,
  isUnderAny,
} from "./read-scope.js";

/**
 * The shell's share of the read scope: a NARROW pre-exec check over the
 * command's tokens, nothing more. A token that is an absolute path
 * under the user's home directory (or the directory homes live in) and
 * lies outside every root is refused, as is a `..` climb that escapes
 * every root; the OS's own prefixes and the temp directory are never
 * refused. No allowlist of commands, no parsing beyond whitespace
 * tokens: `grep -rn x /Users/someone` is what this catches,
 * `ls /usr/local/bin` and `python3 /tmp/helper.py` are what it leaves
 * alone.
 */

export interface ShellScopeEnv {
  /** The user's home directory. */
  home: string;
  platform: NodeJS.Platform;
}

export function defaultShellScopeEnv(): ShellScopeEnv {
  return { home: homedir(), platform: process.platform };
}

/** Prefixes the OS owns: reading there is never wandering. */
const SYSTEM_PREFIXES: Record<"posix" | "win32", readonly string[]> = {
  posix: [
    "/usr",
    "/bin",
    "/sbin",
    "/opt",
    "/dev",
    "/etc",
    "/System",
    "/Library",
    "/Applications",
  ],
  win32: ["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)"],
};

const DRIVE = /^[A-Za-z]:[\\/]/;
/** Quotes glued to a token, a redirection ahead of it, separators after it. */
const QUOTES = /^["'`]+|["'`]+$/g;
const REDIRECT = /^[0-9]*[<>]+/;
const TRAILING = /[;|&),\]]+$/;

function hasClimb(token: string): boolean {
  return token.split(/[\\/]/).includes("..");
}

/**
 * `cmd` followed by every argument — an array, or the JSON-string form
 * of `args` some providers double-serialise — as the shell tool would
 * join them. The prompt's rendering of the command; not what runs.
 */
export function shellCommandLine(args: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof args.cmd === "string") parts.push(args.cmd);
  const list = args.args;
  if (Array.isArray(list)) {
    parts.push(...list.map(String));
  } else if (typeof list === "string" && list.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(list) as unknown;
      if (Array.isArray(parsed)) parts.push(...parsed.map(String));
    } catch {
      // Not JSON: the shell tool refuses this shape itself.
    }
  }
  return parts.join(" ");
}

/**
 * The whitespace tokens of the command: `cmd` (a pre-joined line splits),
 * every argument (an `sh -c` body splits too), and the JSON-string form
 * of `args`.
 */
export function shellTokens(args: Record<string, unknown>): string[] {
  return shellCommandLine(args)
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

interface Candidate {
  path: string;
  /** A relative token that climbs with `..`, resolved against `cwd`. */
  climb: boolean;
}

/** What a token names on disk, if anything this check cares about. */
function candidateOf(
  token: string,
  cwd: string,
  env: ShellScopeEnv,
): Candidate | null {
  let t = token.replace(QUOTES, "").replace(REDIRECT, "").replace(TRAILING, "");
  // `--dir=/x`, `FOO=/x`: the value is what names a path.
  const eq = t.indexOf("=");
  if (eq > 0) {
    const value = t.slice(eq + 1);
    if (/^(~|\/|[A-Za-z]:[\\/])/.test(value)) t = value;
  }
  if (t === "~") return { path: env.home, climb: false };
  if (t.startsWith("~/") || t.startsWith("~\\")) {
    return { path: resolve(env.home, t.slice(2)), climb: false };
  }
  if (env.platform === "win32") {
    // `/w` is a switch on Windows, never a path.
    if (DRIVE.test(t)) return { path: resolve(t), climb: false };
  } else if (t.startsWith("/")) {
    // `//…` is the tail of a URL.
    return t.startsWith("//") ? null : { path: resolve(t), climb: false };
  }
  if (hasClimb(t) && !DRIVE.test(t)) return { path: resolve(cwd, t), climb: true };
  return null;
}

/**
 * The first path a shell call names outside every root that this check
 * refuses, or `null` when the command may run.
 */
export function findShellPathOutsideScope(
  args: Record<string, unknown>,
  ctx: Pick<ToolContext, "workingDir">,
  roots: readonly string[],
  env: ShellScopeEnv = defaultShellScopeEnv(),
): string | null {
  const system = SYSTEM_PREFIXES[env.platform === "win32" ? "win32" : "posix"];
  // The user's area: their home and the directory homes live in (so
  // another user's home counts too).
  const homeParent = dirname(env.home);
  const userArea = [
    env.home,
    ...(homeParent === env.home || dirname(homeParent) === homeParent
      ? []
      : [homeParent]),
  ];
  let cwd = ctx.workingDir;
  if (typeof args.cwd === "string" && args.cwd.length > 0) {
    try {
      cwd = resolveUserPath(args.cwd, ctx.workingDir);
    } catch {
      cwd = ctx.workingDir;
    }
  }
  const candidates: Candidate[] = [];
  if (cwd !== ctx.workingDir) candidates.push({ path: cwd, climb: false });
  for (const token of shellTokens(args)) {
    const candidate = candidateOf(token, cwd, env);
    if (candidate !== null) candidates.push(candidate);
  }
  for (const { path, climb } of candidates) {
    if (isUnderAny(path, system) || isScratchPath(path)) continue;
    if (!isOutsideReadRoots(path, roots)) continue;
    if (climb || isUnderAny(path, userArea)) return path;
  }
  return null;
}
