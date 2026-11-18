/**
 * What a call is, in policy terms: the `action` and the resources a rule's
 * glob is matched against. Two readers: the approval gate (a request it is
 * about to decide) and the dispatcher (a tool call about to run).
 */
import { programName } from "../tools/os/shell-command-guard/command-segments.js";
import { shellRuleSegments, shellRunsUnreadableScript } from "../tools/os/shell/shell-command-argv.js";
import { coerceShellArgs, needsShellInterpretation } from "../tools/os/shell/shell-interpretation.js";
import type { PolicyAction } from "./policy-schema.js";

export interface PolicyTarget {
  action: PolicyAction;
  resources: string[];
  /**
   * A shell line that feeds a script no one can read to a shell or an
   * interpreter (`printf 'rm -rf x' | sh`): any shell `deny` or `ask`
   * rule matches it, as saved deny and ask rules do.
   */
  unreadable?: boolean;
}

/** The request fields the gate passes (a subset of `ApprovalRequest`). */
export interface PolicyGateRequest {
  tool: string;
  category: string;
  commandArgv?: string[];
  commandSegments?: string[][];
  commandUnreadable?: boolean;
  targetPaths?: string[];
  affectedResources?: string[];
  grantKey?: string;
}

const SHELL_CATEGORIES = new Set(["shell", "shell_dangerous"]);
const EDIT_CATEGORIES = new Set(["fs_write_workspace", "fs_write_home", "fs_trash"]);
const FETCH_CATEGORIES = new Set(["http", "http_write", "browser_offsite"]);
const EDIT_TOOLS = new Set(["os.fs.write", "os.fs.edit", "os.fs.patch", "os.fs.trash", "os.fs.move", "os.fs.restore"]);
const FETCH_TOOLS = new Set(["os.web.fetch", "os.web.crawl", "os.http.request"]);

/** `mcp.<server>.<tool>` as `<server>/<tool>`; null for any other tool. */
export function mcpResource(tool: string): string | null {
  if (!tool.startsWith("mcp.")) return null;
  const rest = tool.slice(4);
  const dot = rest.indexOf(".");
  return dot <= 0 ? rest : `${rest.slice(0, dot)}/${rest.slice(dot + 1)}`;
}

function nonEmpty(values: ReadonlyArray<string | undefined>): string[] {
  const out = values.filter((v): v is string => typeof v === "string" && v.length > 0);
  return out.length > 0 ? [...new Set(out)] : [""];
}

/** The target of an approval request, or null when no policy action covers it. */
export function gateRequestTarget(request: PolicyGateRequest): PolicyTarget | null {
  const mcp = mcpResource(request.tool);
  if (mcp !== null) return { action: "mcp", resources: [mcp] };
  if (SHELL_CATEGORIES.has(request.category) || request.tool === "os.shell.run") {
    const argvs = [...(request.commandArgv ? [request.commandArgv] : []), ...(request.commandSegments ?? [])];
    return {
      action: "shell",
      resources: nonEmpty(argvs.flatMap(argvResources)),
      ...(request.commandUnreadable === true ? { unreadable: true } : {}),
    };
  }
  if (EDIT_CATEGORIES.has(request.category)) {
    return { action: "edit", resources: nonEmpty([...(request.targetPaths ?? []), ...(request.affectedResources ?? [])]) };
  }
  if (FETCH_CATEGORIES.has(request.category)) {
    return { action: "webfetch", resources: nonEmpty(urlResources([...(request.affectedResources ?? []), request.grantKey])) };
  }
  return null;
}

function record(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * One command as rule globs see it: its words joined, and again with the
 * program reduced to its name (`/bin/rm -rf x` is also `rm -rf x`), the
 * way saved rules compare argv[0].
 */
function argvResources(argv: readonly string[]): string[] {
  const words = argv.filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const raw = words.join(" ");
  const named = [programName(words[0]!), ...words.slice(1)].join(" ");
  return named === raw ? [raw] : [raw, named];
}

/**
 * A command line as policy rules see it: the whole line, then every
 * command it runs, read the way saved deny and ask rules read it
 * (`shellRuleSegments`: split at `&&`, `||`, `;`, `|`, `&`, past
 * wrappers like `sudo` and `env`, inside `bash -c`, `eval` and
 * `find -exec`), each also with its program reduced to its name.
 */
export function shellResources(cmd: string, args: readonly string[] = []): string[] {
  const line = [cmd, ...args].join(" ").trim().replace(/\s+/g, " ");
  const useShell = needsShellInterpretation(cmd, args);
  const segments = shellRuleSegments(cmd, args, useShell);
  return nonEmpty([line, ...segments.flatMap(argvResources)]);
}

/**
 * URLs as webfetch globs see them: as given, then the way a fetch reads
 * them (`new URL`: scheme and host lowercased, no user info, no default
 * port, a `/` path at least), then the origin and the host on their own,
 * so a host-only rule (`https://evil.com`, `evil.com`, `*.evil.com`)
 * covers every URL on it. `HTTPS://Evil.com:443` and
 * `https://user@evil.com` read as `https://evil.com/`.
 */
export function urlResources(values: ReadonlyArray<string | undefined>): Array<string | undefined> {
  const out: Array<string | undefined> = [];
  for (const value of values) {
    out.push(value);
    if (value === undefined) continue;
    let u: URL;
    try {
      u = new URL(value.trim());
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    u.username = "";
    u.password = "";
    if (u.hostname.endsWith(".")) u.hostname = u.hostname.slice(0, -1);
    out.push(u.href, u.origin, u.host, u.hostname);
  }
  return out;
}

/** The target of a tool call by its arguments, or null when no policy action covers it. */
export function toolCallTarget(tool: string, args: unknown): PolicyTarget | null {
  const a = record(args);
  const mcp = mcpResource(tool);
  if (mcp !== null) return { action: "mcp", resources: [mcp] };
  if (tool === "os.shell.run") {
    const cmd = str(a.cmd);
    if (cmd === undefined) return null; // wait / kill / jobs run nothing new
    const rest = coerceShellArgs(a.args) ?? [];
    const unreadable = shellRunsUnreadableScript(cmd, rest, needsShellInterpretation(cmd, rest));
    return { action: "shell", resources: shellResources(cmd, rest), ...(unreadable ? { unreadable: true } : {}) };
  }
  if (EDIT_TOOLS.has(tool)) {
    const paths = Array.isArray(a.paths) ? a.paths.map(str) : [];
    return { action: "edit", resources: nonEmpty([str(a.path), str(a.from), str(a.to), str(a.destination), ...paths]) };
  }
  if (FETCH_TOOLS.has(tool)) return { action: "webfetch", resources: nonEmpty(urlResources([str(a.url)])) };
  if (tool === "os.web.search") return { action: "websearch", resources: nonEmpty([str(a.query)]) };
  if (tool === "skill.view") return { action: "skill", resources: nonEmpty([str(a.name)]) };
  if (tool === "skill.run_script") return { action: "skill", resources: nonEmpty([str(a.skill)]) };
  return null;
}
