/**
 * Which tool calls send something outside the machine (ATO-1089).
 *
 * A fit-test replays the user's tasks on other models. A task whose
 * original run sent an email, pushed a branch, posted a comment or made
 * a writing HTTP request is left out of the set: replaying it could do
 * the same thing again under the user's name. The rule is deliberately
 * wide; a task wrongly left out costs one test case, a task wrongly kept
 * could cost a duplicate email.
 */
import type { ApprovalCategory } from "../approval/index.js";

/** Tools whose whole job is to send, publish or act on a remote account. */
const OUTBOUND_TOOLS: ReadonlySet<string> = new Set([
  "os.email.send",
  "os.git.push",
  "github.issue.create",
  "github.issue.comment",
  "github.pr.create",
  // A click or typing on a page can submit a form under the user's
  // logged-in accounts; the transcript cannot tell which one did.
  "browser.click",
  "browser.type",
]);

/** Approval categories that mean the call reached outside. */
const OUTBOUND_APPROVALS: ReadonlySet<ApprovalCategory> = new Set<ApprovalCategory>([
  "email",
  "publish",
  "git_remote",
  "browser_commit",
  "browser_secret",
  "paid_generation",
]);

const READ_HTTP_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** Shell commands that push, publish or send. Matched anywhere in the line. */
const OUTBOUND_SHELL =
  /\bgit\s+push\b|\bgh\s+(?:pr|issue|release|repo|gist|api)\b|\bnpm\s+publish\b|\b(?:scp|rsync|sftp|ssh)\s|\bcurl\b[^|;&]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--data|\s-d\s|\s-F\s|--upload-file|-T\s)|\bwget\b[^|;&]*--post|\b(?:sendmail|mail)\s/i;

/** MCP tool name words that read; any other MCP call counts as outbound. */
const MCP_READ_WORDS = /^(?:search|list|get|read|fetch|query|find|describe|lookup|view)$/;
const MCP_WRITE_WORDS =
  /^(?:send|post|create|update|delete|remove|write|publish|comment|reply|message|upload|push|set|add|invite|share|edit|patch|put|move|archive|star|follow|like)$/;

/**
 * An MCP tool (`mcp.<server>.<tool>`, Composio's `mcp.composio.GMAIL_SEND_EMAIL`)
 * is kept only when its name has a reading word and no writing word.
 */
function isOutboundMcp(tool: string): boolean {
  const last = tool.split(".").slice(2).join(".");
  const words = last.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.some((w) => MCP_WRITE_WORDS.test(w))) return true;
  return !words.some((w) => MCP_READ_WORDS.test(w));
}

export interface ToolCallFacts {
  tool: string;
  args: Record<string, unknown>;
  /** Approval categories recorded on the call's result, if any. */
  approvalCategories?: readonly ApprovalCategory[];
}

/** Whether this call sent, published or wrote something outside the machine. */
export function isOutboundCall(call: ToolCallFacts): boolean {
  if (OUTBOUND_TOOLS.has(call.tool)) return true;
  if (call.approvalCategories?.some((c) => OUTBOUND_APPROVALS.has(c))) return true;
  if (call.tool.startsWith("mcp.")) {
    // The MCP meta tools only read the servers' catalogs.
    if (/^mcp\.(?:resource|prompt)\.(?:list|read|get)$/.test(call.tool)) return false;
    return isOutboundMcp(call.tool);
  }
  if (call.tool === "os.http.request") {
    const method = typeof call.args.method === "string" ? call.args.method.toUpperCase() : "GET";
    return !READ_HTTP_METHODS.has(method);
  }
  if (call.tool === "os.shell.run") {
    return OUTBOUND_SHELL.test(shellLine(call.args));
  }
  return false;
}

/** The command line of an `os.shell.run` call: `cmd` (a string or argv) plus `args`. */
function shellLine(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const value of [args.cmd, args.args]) {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) parts.push(...value.filter((v): v is string => typeof v === "string"));
  }
  return `${parts.join(" ")} `;
}
