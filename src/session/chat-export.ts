import { Marked, type Tokens } from "marked";

import type { ConversationTurn } from "./conversation-turn.js";
import type { SessionState } from "./session-state.js";
import { readSessionTitle } from "./session-title.js";

/**
 * Export one chat as a document (ATO-1054): Markdown first, and HTML /
 * DOCX built from that Markdown so every format says the same thing.
 *
 * What goes in is what the person saw: their messages, the agent's
 * replies (progress notes included), one line per tool step, and the
 * files a reply delivered. Reasoning blocks, raw tool output and the
 * prompt-only state (loaded skills, facts, snapshots) stay out: they are
 * the agent's working memory, not the conversation, and raw tool output
 * can be megabytes of file content the person never read.
 */

export type ChatExportFormat = "markdown" | "html" | "docx";

/** The formats a caller may name, with the short spellings people type. */
export function parseChatExportFormat(raw: string | null | undefined): ChatExportFormat | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "md" || v === "markdown") return "markdown";
  if (v === "html" || v === "htm") return "html";
  if (v === "docx" || v === "word") return "docx";
  return null;
}

export const CHAT_EXPORT_MIME: Record<ChatExportFormat, string> = {
  markdown: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const EXTENSION: Record<ChatExportFormat, string> = { markdown: "md", html: "html", docx: "docx" };

/** A tool step in words, as the live stream labels it once done. */
export type DescribeExportedToolCall = (call: {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
}) => string;

export interface ChatExportOptions {
  /** One line per tool step. Default true. */
  includeTools?: boolean;
  /** Words for a tool step; without it the line names the tool. */
  describeToolCall?: DescribeExportedToolCall;
  /** Export time for the header. Default `Date.now()`. */
  now?: number;
}

/** The chat's name: its title, else its first prompt cut short, else its id. */
export function chatExportTitle(state: SessionState): string {
  const title = readSessionTitle(state.metadata);
  if (title) return title;
  const first = state.turns.find((t) => t.kind === "user" && t.text.trim().length > 0);
  if (first && first.kind === "user") {
    const line = first.text.trim().split(/\r?\n/, 1)[0] ?? "";
    return line.length > 60 ? `${line.slice(0, 57).trimEnd()}...` : line;
  }
  return `Chat ${state.id}`;
}

/**
 * A file name for the export: the title with anything a file system or
 * a shell would trip on replaced, never empty, never over 80 characters.
 */
export function chatExportFilename(state: SessionState, format: ChatExportFormat): string {
  const base = chatExportTitle(state)
    .normalize("NFKC")
    // Path separators, reserved Windows characters, control characters.
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return `${base || `chat-${state.id}`}.${EXTENSION[format]}`;
}

/** `2026-11-12 14:03 UTC`: the same text on every machine. */
function stamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

type ToolCallTurn = Extract<ConversationTurn, { kind: "assistant_tool_call" }>;

/** Whether the call at `index` failed: the first result for its tool after it. */
function callFailed(turns: readonly ConversationTurn[], index: number, call: ToolCallTurn): boolean {
  for (let i = index + 1; i < turns.length; i += 1) {
    const t = turns[i];
    if (!t || t.kind === "user") return false;
    if (t.kind === "tool_result" && t.tool === call.tool) return t.status === "error";
  }
  return false;
}

/** The chat as Markdown. */
export function renderChatMarkdown(state: SessionState, options: ChatExportOptions = {}): string {
  const includeTools = options.includeTools !== false;
  const out: string[] = [];
  out.push(`# ${chatExportTitle(state).replace(/\r?\n/g, " ")}`, "");
  const meta = [`Exported from Atomic Agent on ${stamp(options.now ?? Date.now())}`];
  const started = stamp(state.createdAt);
  if (started) meta.push(`chat started ${started}`);
  out.push(`_${meta.join(", ")}._`, "");

  let speaker: "user" | "agent" | null = null;
  let toolLines: string[] = [];
  const agentHeading = (): void => {
    if (speaker !== "agent") {
      out.push("## Atomic Agent", "");
      speaker = "agent";
    }
  };
  const flushTools = (): void => {
    if (toolLines.length === 0) return;
    agentHeading();
    out.push(...toolLines, "");
    toolLines = [];
  };

  state.turns.forEach((turn, index) => {
    switch (turn.kind) {
      case "user": {
        flushTools();
        out.push(turn.steered ? "## You (sent while it was working)" : "## You", "");
        out.push(turn.text.trimEnd() || "_(empty message)_", "");
        speaker = "user";
        return;
      }
      case "assistant_tool_call": {
        if (!includeTools) return;
        const failed = callFailed(state.turns, index, turn);
        const words = options.describeToolCall
          ? options.describeToolCall({ tool: turn.tool, args: turn.args, ok: !failed })
          : `Used ${turn.tool}`;
        toolLines.push(`- ${words.replace(/\r?\n/g, " ")}${failed ? " (failed)" : ""}`);
        return;
      }
      case "tool_result":
        return;
      case "assistant_reply": {
        flushTools();
        agentHeading();
        if (turn.stopped) {
          out.push("_Stopped._", "");
          return;
        }
        out.push(turn.text.trimEnd() || "_(empty reply)_", "");
        if (turn.attachments && turn.attachments.length > 0) {
          out.push("Files:", "", ...turn.attachments.map((p) => `- \`${p}\``), "");
        }
        return;
      }
    }
  });
  flushTools();
  return `${out.join("\n").trimEnd()}\n`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only links that open a page or a mail; a `javascript:` link becomes its text. */
function safeHref(href: string): string | null {
  const h = href.trim();
  return /^(https?:|mailto:|#)/i.test(h) ? h : null;
}

/**
 * HTML a browser or Electron's `printToPDF` can lay out. Raw HTML in a
 * message is shown as text, never run, and the page may load nothing
 * from the network (CSP), so opening an export cannot fetch or execute
 * anything a message carried.
 */
export function renderChatHtml(markdown: string, title: string): string {
  const md = new Marked({
    gfm: true,
    renderer: {
      html(token: Tokens.HTML | Tokens.Tag): string {
        return escapeHtml(token.text);
      },
      link(token: Tokens.Link): string {
        const text = this.parser.parseInline(token.tokens);
        const href = safeHref(token.href);
        return href ? `<a href="${escapeHtml(href)}">${text}</a>` : text;
      },
      image(token: Tokens.Image): string {
        return escapeHtml(token.text || token.href);
      },
    },
  });
  const body = md.parse(markdown, { async: false });
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    `<title>${escapeHtml(title)}</title>`,
    "<style>",
    "body{font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f;max-width:760px;margin:32px auto;padding:0 24px}",
    "h1{font-size:24px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 6px;color:#555;text-transform:uppercase;letter-spacing:.04em}",
    "pre{background:#f5f5f7;padding:12px;border-radius:6px;overflow-x:auto;white-space:pre-wrap;word-break:break-word}",
    "code{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
    "table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}blockquote{margin:0;padding-left:12px;border-left:3px solid #ccc;color:#555}",
    "</style>",
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
