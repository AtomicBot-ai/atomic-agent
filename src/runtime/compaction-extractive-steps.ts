import type { ConversationTurn } from "../session/conversation-turn.js";

type ToolCall = Pick<Extract<ConversationTurn, { kind: "assistant_tool_call" }>, "tool" | "args">;
type ToolResult = Extract<ConversationTurn, { kind: "tool_result" }>;

/** What one tool call plus its result contributes to an extractive summary. */
export interface ToolStepFacts {
  /** `read /a.ts → ok`, ``ran `npm test` → exit 1: FAIL x``. */
  line: string;
  /** `tool: first error line`, when the step failed. */
  error?: string;
  changed: string[];
  read: string[];
  urls: string[];
}

const TARGET_MAX_CHARS = 160;
const ERROR_MAX_CHARS = 200;
/** Error bodies can be large; their first meaningful line is near the top. */
const ERROR_SCAN_CHARS = 8_000;

const CHANGES = new Map([
  ["os.fs.write", "wrote"], ["os.fs.edit", "edited"], ["os.fs.patch", "patched"],
  ["os.fs.trash", "trashed"], ["os.fs.restore", "restored"], ["os.fs.archive.extract", "extracted"],
  ["os.clipboard.write", "copied to clipboard"],
]);
const READS = new Map([
  ["os.fs.read", "read"], ["os.fs.read_document", "read"], ["os.fs.archive.read_entry", "read"],
  ["os.fs.archive.list", "listed"], ["os.fs.list", "listed"], ["os.fs.glob", "searched files in"],
  ["os.fs.grep", "searched"], ["os.fs.diff", "diffed"], ["os.fs.hash", "hashed"],
]);
const FETCHES = new Map([
  ["os.web.fetch", "fetched"], ["os.http.request", "requested"], ["browser.navigate", "opened"],
]);

function short(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function stringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Paths a patch names in its own headers (`*** Update File:`, `+++ b/`). */
function patchPaths(patch: string): string[] {
  const found = new Set<string>();
  for (const match of patch.slice(0, 200_000).matchAll(/^(?:\*\*\* (?:Update|Add|Delete) File: |\+\+\+ (?:b\/)?)(\S.*)$/gm)) {
    const path = match[1]!.trim();
    if (path !== "/dev/null") found.add(path);
  }
  return [...found];
}

/** The first line that reads like an error, else the first non-empty line. */
export function firstErrorLine(summary: string): string {
  const lines = summary.slice(0, ERROR_SCAN_CHARS).split("\n").map((line) => line.trim()).filter(Boolean);
  const meaningful = lines.filter((line) => !/^(\$ |exit: )/.test(line));
  const pick = meaningful.find((line) => /error|fail|exception|denied|not found|cannot|invalid|refused|timed? ?out/i.test(line))
    ?? meaningful[0] ?? lines[0] ?? "";
  return short(pick, ERROR_MAX_CHARS);
}

function outcome(call: ToolCall, result: ToolResult | undefined): { text: string; error?: string } {
  if (!result) return { text: "no result recorded" };
  if (call.tool === "os.shell.run") {
    const exit = /^exit: (.+)$/m.exec(result.summary.slice(0, ERROR_SCAN_CHARS))?.[1]?.trim();
    if (result.status === "ok") return { text: exit ? `exit ${exit}` : "ok" };
    const first = firstErrorLine(result.summary);
    return { text: `${exit ? `exit ${exit}` : "error"}${first ? `: ${first}` : ""}`, error: first || "failed" };
  }
  if (result.status === "ok") return { text: "ok" };
  const first = firstErrorLine(result.summary);
  return { text: `error${first ? `: ${first}` : ""}`, error: first || "failed" };
}

/**
 * One line for a tool step: what it did, to what, and how it ended. Only
 * arguments that name a target are kept (paths, URLs, queries, commands);
 * written content and result bodies are not.
 */
export function describeToolStep(call: ToolCall, result: ToolResult | undefined): ToolStepFacts {
  const facts: ToolStepFacts = { line: "", changed: [], read: [], urls: [] };
  const args = call.args ?? {};
  const path = stringArg(args, "path", "filePath", "file", "dir", "directory");
  const url = stringArg(args, "url");
  let target: string;
  let verb: string;
  if (call.tool === "os.shell.run") {
    const argv = Array.isArray(args.args) ? args.args.filter((a): a is string => typeof a === "string") : [];
    verb = "ran";
    target = `\`${short([stringArg(args, "cmd") ?? "", ...argv].join(" "), TARGET_MAX_CHARS)}\``;
  } else if (CHANGES.has(call.tool)) {
    const paths = path ? [path] : call.tool === "os.fs.patch" ? patchPaths(stringArg(args, "patch") ?? "") : [];
    verb = CHANGES.get(call.tool)!;
    target = paths.length ? paths.join(", ") : "";
    if (result?.status !== "error") facts.changed.push(...paths);
  } else if (READS.has(call.tool)) {
    verb = READS.get(call.tool)!;
    const pattern = stringArg(args, "pattern", "query", "glob");
    const where = path ?? result?.read?.path;
    target = [pattern ? `"${short(pattern, 80)}"` : "", where ? `${pattern ? "in " : ""}${where}` : ""].filter(Boolean).join(" ");
    if (where && result?.status !== "error") facts.read.push(where);
  } else if (FETCHES.has(call.tool) || url) {
    verb = FETCHES.get(call.tool) ?? call.tool;
    target = url ?? "";
    if (url) facts.urls.push(url);
  } else {
    verb = call.tool;
    const query = stringArg(args, "query", "q", "name", "title", "id", "cmd");
    target = path ?? (query ? `"${short(query, 80)}"` : "");
    if (path && call.tool.startsWith("os.fs.")) facts.read.push(path);
  }
  const ending = outcome(call, result);
  facts.line = `${verb}${target ? ` ${short(target, TARGET_MAX_CHARS)}` : ""} → ${ending.text}`;
  if (ending.error) facts.error = `${call.tool}${target ? ` ${short(target, 80)}` : ""}: ${ending.error}`;
  return facts;
}
