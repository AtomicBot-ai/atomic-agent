/**
 * What a call is, in policy terms: the `action` and the resources a rule's
 * glob is matched against. Two readers: the approval gate (a request it is
 * about to decide) and the dispatcher (a tool call about to run).
 */
import type { PolicyAction } from "./policy-schema.js";

export interface PolicyTarget {
  action: PolicyAction;
  resources: string[];
}

/** The request fields the gate passes (a subset of `ApprovalRequest`). */
export interface PolicyGateRequest {
  tool: string;
  category: string;
  commandArgv?: string[];
  commandSegments?: string[][];
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
    const segments = (request.commandSegments ?? []).map((argv) => argv.join(" "));
    const whole = request.commandArgv?.join(" ");
    return { action: "shell", resources: nonEmpty([whole, ...segments]) };
  }
  if (EDIT_CATEGORIES.has(request.category)) {
    return { action: "edit", resources: nonEmpty([...(request.targetPaths ?? []), ...(request.affectedResources ?? [])]) };
  }
  if (FETCH_CATEGORIES.has(request.category)) {
    return { action: "webfetch", resources: nonEmpty([...(request.affectedResources ?? []), request.grantKey]) };
  }
  return null;
}

function record(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A command line and each command in it, split at `&&`, `||`, `;`, `|` and newlines. */
export function shellResources(cmd: string, args: readonly string[] = []): string[] {
  const line = [cmd, ...args].join(" ").trim();
  const parts = line.split(/&&|\|\||[;|\n]/).map((p) => p.trim().replace(/\s+/g, " "));
  return nonEmpty([line.replace(/\s+/g, " "), ...parts]);
}

/** The target of a tool call by its arguments, or null when no policy action covers it. */
export function toolCallTarget(tool: string, args: unknown): PolicyTarget | null {
  const a = record(args);
  const mcp = mcpResource(tool);
  if (mcp !== null) return { action: "mcp", resources: [mcp] };
  if (tool === "os.shell.run") {
    const cmd = str(a.cmd);
    if (cmd === undefined) return null; // wait / kill / jobs run nothing new
    const rest = Array.isArray(a.args) ? a.args.filter((x): x is string => typeof x === "string") : [];
    return { action: "shell", resources: shellResources(cmd, rest) };
  }
  if (EDIT_TOOLS.has(tool)) {
    const paths = Array.isArray(a.paths) ? a.paths.map(str) : [];
    return { action: "edit", resources: nonEmpty([str(a.path), str(a.from), str(a.to), str(a.destination), ...paths]) };
  }
  if (FETCH_TOOLS.has(tool)) return { action: "webfetch", resources: nonEmpty([str(a.url)]) };
  if (tool === "os.web.search") return { action: "websearch", resources: nonEmpty([str(a.query)]) };
  if (tool === "skill.view") return { action: "skill", resources: nonEmpty([str(a.name)]) };
  if (tool === "skill.run_script") return { action: "skill", resources: nonEmpty([str(a.skill)]) };
  return null;
}
