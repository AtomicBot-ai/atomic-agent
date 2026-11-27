import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { isInside } from "../../approval/fanout-scope.js";
import {
  compressToolResult,
  type CompressedToolResult,
} from "../../compressor/result-compressor.js";
import {
  MCP_SECRET_HOME_PATHS,
  SECRET_HOME_PATHS,
} from "../../sandbox/os-sandbox.js";
import { resolveUserPath } from "../os/expand-home.js";
import type { ToolContext } from "../tool-registry.js";
import { canonical } from "./read-scope.js";
import { READ_TOOL_TARGETS, URL_LIKE } from "./read-scope-targets.js";

/**
 * Where a channel guest's turn may READ (ATO-2221).
 *
 * A guest (`telegram.allowedUsers`) gets read-only tools, but read-only
 * is not harmless: at approval level 5 `fs_read_outside` runs unasked,
 * so a guest could have read `~/.ssh/id_rsa` or the agent's `.env`. So
 * a call from a guest session (`ToolContext.guest`) is checked here, at
 * dispatch and at every approval level, and REFUSED (never asked: the
 * owner cannot vouch for every path a stranger names) when a target:
 *
 *  - resolves outside the working directory, lexically or canonically
 *    (a symlink inside pointing out is outside; no scratch allowance,
 *    no user-named roots, no grants);
 *  - is, or is inside, a credential folder of the home directory
 *    (`SECRET_HOME_PATHS`, `MCP_SECRET_HOME_PATHS`) or the agent's state
 *    directory, or is a `.env` / `.env.*` file;
 *  - for a tool that walks a folder, contains one of those folders (a
 *    working directory that is the home folder cannot be grepped whole);
 *  - is a `file:` URL.
 *
 * `files.search` without a `folder` searches the owner's "My files"
 * folders, so a guest must name a folder inside the working directory.
 * Git tools are checked by their `repo` (default: the working
 * directory) and any absolute `path`. The shell is refused outright.
 *
 * Precedent: OpenClaw runs non-owner sessions in a sandbox confined to
 * the workspace, and Claude Code's permission rules deny `Read` of
 * `~/.ssh` and `.env` whatever the mode.
 */

export const GUEST_READ_REFUSAL_REASON = "guest-read-outside-scope";

/** Tools that read a folder's content, so naming a parent of a secret reads it. */
const WALKING_TOOLS: ReadonlySet<string> = new Set([
  "os.fs.grep",
  "os.fs.glob",
  "os.fs.list",
  "os.fs.code_map",
  "os.code.search",
  "os.code.rewrite",
  "files.search",
]);

/** Read-only git tools and what they read: the repo, plus absolute paths. */
export const GUEST_GIT_TOOLS: ReadonlySet<string> = new Set([
  "os.git.status",
  "os.git.log",
  "os.git.diff",
  "os.git.show",
  "os.git.blame",
  "os.git.branch",
]);

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The raw targets of a guest call; `null` when the call is refused as a whole. */
function guestTargets(
  tool: string,
  args: Record<string, unknown>,
  workingDir: string,
): string[] | null {
  if (GUEST_GIT_TOOLS.has(tool)) {
    const paths = [str(args.path), ...(Array.isArray(args.paths) ? args.paths.map(str) : [])]
      .filter((p): p is string => p !== undefined && isAbsolute(p));
    return [str(args.repo) ?? workingDir, ...paths];
  }
  const targetsOf = READ_TOOL_TARGETS.get(tool);
  if (targetsOf === undefined) return [];
  if (tool === "files.search" && str(args.folder) === undefined) return null;
  const targets = targetsOf(args);
  // An omitted root is the working directory: walked, so it is checked.
  if (WALKING_TOOLS.has(tool) && targets.length === 0) return [workingDir];
  return targets;
}

/** Home-relative secrets plus the state directory, each lexical and canonical. */
function deniedFolders(home: string, stateDir: string | undefined): string[] {
  const raw = [
    ...SECRET_HOME_PATHS.map((p) => join(home, p)),
    ...MCP_SECRET_HOME_PATHS.map((p) => join(home, p)),
    ...(stateDir === undefined ? [] : [resolve(stateDir)]),
  ];
  return [...new Set(raw.flatMap((p) => [p, canonical(p)]))];
}

function isEnvFile(path: string): boolean {
  const name = basename(path);
  return name === ".env" || name.startsWith(".env.");
}

/** Why `absolute` is refused to a guest, or `null` when it may be read. */
function guestDenial(
  tool: string,
  absolute: string,
  workingDir: string,
  denied: readonly string[],
): string | null {
  const lexical = resolve(absolute);
  const real = canonical(lexical);
  const root = resolve(workingDir);
  if (!isInside(root, lexical) || !isInside(canonical(root), real)) {
    return `${absolute} is outside the working directory (${workingDir})`;
  }
  if (isEnvFile(lexical) || isEnvFile(real)) return `${absolute} is a secrets file`;
  for (const secret of denied) {
    if (isInside(secret, lexical) || isInside(secret, real)) {
      return `${absolute} is a credential folder or the agent's own state`;
    }
    if (WALKING_TOOLS.has(tool) && (isInside(lexical, secret) || isInside(real, secret))) {
      return `${absolute} contains a credential folder or the agent's own state (${secret})`;
    }
  }
  return null;
}

export interface GuestReadOptions {
  /** The agent's state directory; denied whole to guests. */
  stateDir?: string;
  /** A test seam for the home folder. */
  home?: string;
}

/**
 * The refusal for a guest session's call, or `null` when it may run:
 * not a guest session, or every target allowed (see the module note).
 */
export function checkGuestRead(
  tool: string,
  args: Record<string, unknown>,
  ctx: Pick<ToolContext, "guest" | "workingDir">,
  options: GuestReadOptions = {},
): CompressedToolResult | null {
  if (ctx.guest !== true) return null;
  const targets = guestTargets(tool, args, ctx.workingDir);
  if (targets === null) {
    return guestRefusal(tool, `a guest must name a folder inside the working directory (${ctx.workingDir})`);
  }
  const denied = deniedFolders(options.home ?? homedir(), options.stateDir);
  for (const raw of targets) {
    if (/^file:/i.test(raw)) return guestRefusal(tool, `${raw} is a file URL`);
    if (URL_LIKE.test(raw)) continue;
    let absolute: string;
    try {
      absolute = resolveUserPath(raw, ctx.workingDir);
    } catch {
      return guestRefusal(tool, `${raw} cannot be resolved`);
    }
    const why = guestDenial(tool, absolute, ctx.workingDir, denied);
    if (why !== null) return guestRefusal(tool, why);
  }
  return null;
}

/** The refusal for a guest's shell command: guests never run one. */
export function guestShellRefusal(tool: string): CompressedToolResult {
  return guestRefusal(tool, "guests cannot run commands");
}

function guestRefusal(tool: string, why: string): CompressedToolResult {
  const output =
    `${tool} refused: ${why}. This chat is a guest's, and a guest reads only inside the working directory, never credentials or the agent's own files. ` +
    `Answer from what you can read there, and say what you could not.`;
  return compressToolResult(
    {
      tool,
      status: "error",
      output,
      details: { reason: GUEST_READ_REFUSAL_REASON },
    },
    { maxSummaryLength: Math.max(1000, output.length + 50) },
  );
}
