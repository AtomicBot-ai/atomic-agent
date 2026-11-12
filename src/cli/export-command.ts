import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { getConfig } from "../config/index.js";
import {
  exportChat,
  parseChatExportFormat,
  SessionStore,
  type SessionState,
} from "../session/index.js";
import { describeToolCall } from "../tools/describe-tool-call.js";

const HELP =
  [
    "atomic-agent export — save one chat as Markdown, HTML or Word (ATO-1054)",
    "",
    "Usage:",
    "  atomic-agent export <sessionId> [--format md|html|docx] [--out <file>] [--no-tools]",
    "  atomic-agent export --last      [--format md|html|docx] [--out <file>] [--no-tools]",
    "",
    "Markdown and HTML go to stdout unless --out is given. Word (docx) is",
    "written to --out, or to a file named after the chat in the current",
    "folder. --last exports the most recent chat. --no-tools leaves out the",
    "one line per tool step. For a PDF, open the HTML in a browser and print",
    "it, or use Export in the desktop app. Session ids: `/session` in the TUI.",
    "",
    "Examples:",
    "  atomic-agent export --last > chat.md",
    "  atomic-agent export s-1234 --format docx --out ~/Documents/chat.docx",
  ].join("\n") + "\n";

/** Exit codes follow the dispatcher's split: 0 ok, 1 failed, 2 usage. */
export async function exportCommand(args: string[]): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const parsed = parseExportArgs(args);
  if (typeof parsed === "string") {
    process.stderr.write(`${parsed}\n${HELP}`);
    return 2;
  }

  const config = getConfig();
  const store = new SessionStore({ dbFile: config.paths.sessionsDbFile });
  let state: SessionState | null;
  try {
    state = parsed.last ? lastChat(store) : store.load(parsed.sessionId);
  } finally {
    store.close();
  }
  if (!state) {
    process.stderr.write(parsed.last ? "no chats to export yet\n" : `session not found: ${parsed.sessionId}\n`);
    return 1;
  }

  const file = await exportChat(state, parsed.format, {
    includeTools: parsed.tools,
    describeToolCall: (call) => describeToolCall({ name: call.tool, args: call.args, ok: call.ok }).line,
  });
  const out = parsed.out ?? (typeof file.body === "string" ? null : file.filename);
  if (out === null) {
    process.stdout.write(file.body as string);
    return 0;
  }
  const path = resolve(out);
  writeFileSync(path, file.body);
  process.stderr.write(`exported ${state.id} -> ${path}\n`);
  return 0;
}

export interface ParsedExportArgs {
  sessionId: string;
  last: boolean;
  format: NonNullable<ReturnType<typeof parseChatExportFormat>>;
  out: string | null;
  tools: boolean;
}

/** The flags, or the usage error to print. Exported for tests. */
export function parseExportArgs(args: readonly string[]): ParsedExportArgs | string {
  let sessionId = "";
  let last = false;
  let formatRaw: string | null = null;
  let out: string | null = null;
  let tools = true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--last") last = true;
    else if (arg === "--no-tools") tools = false;
    else if (arg === "--format" || arg === "--out") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) return `${arg} needs a value`;
      if (arg === "--format") formatRaw = value;
      else out = value;
      i += 1;
    } else if (arg.startsWith("-")) return `unknown option: ${arg}`;
    else if (sessionId) return `one session id only (got ${sessionId} and ${arg})`;
    else sessionId = arg;
  }
  if (!last && !sessionId) return "give a session id or --last";
  if (last && sessionId) return "give a session id or --last, not both";
  const format = parseChatExportFormat(formatRaw);
  if (!format) return `unknown format: ${formatRaw} (md, html or docx)`;
  return { sessionId, last, format, out, tools };
}

/** The newest chat someone has written in; unnamed empty sessions are skipped. */
function lastChat(store: SessionStore): SessionState | null {
  return store.listRecent(20).find((s) => s.turns.some((t) => t.kind === "user")) ?? null;
}
