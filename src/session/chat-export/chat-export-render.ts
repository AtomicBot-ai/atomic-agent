/**
 * A chat as one file to hand a colleague (ATO-581): a self-contained
 * HTML page or plain Markdown, built from the user messages and closing
 * replies only, each passed through `redactForShare`.
 *
 * The HTML carries no script and no external resource, and its CSP says
 * so, so opening it from a gist, a mail attachment or the disk runs
 * nothing. Message text is escaped before the small Markdown subset
 * below is applied, so a reply that contains HTML shows it as text.
 */

import {
  addRedactionCounts,
  emptyRedactionCounts,
  redactForShare,
  type ShareRedactionContext,
  type ShareRedactionCounts,
} from "./chat-export-redact.js";

/** One user message or closing reply, as `SessionStore.listChatLines` returns it. */
export interface ChatExportLine {
  kind: "user" | "assistant_reply";
  text: string;
}

export interface ChatExportInput {
  title: string;
  lines: readonly ChatExportLine[];
  /** When the export was made; printed in the footer. */
  exportedAt: Date;
  /** `atomic-agent <version>` in the footer. */
  appVersion?: string;
}

export interface ChatExportMessage {
  role: "user" | "assistant";
  text: string;
}

/** What goes into the file, already redacted. */
export interface ChatExport {
  title: string;
  messages: ChatExportMessage[];
  exportedAt: Date;
  appVersion?: string;
  counts: ShareRedactionCounts;
}

export type ChatExportFormat = "html" | "md";

const FALLBACK_TITLE = "Chat";
const MAX_TITLE_CHARS = 120;

/** Redact every line and the title; empty messages are dropped. */
export function buildChatExport(
  input: ChatExportInput,
  ctx: ShareRedactionContext,
): ChatExport {
  const counts = emptyRedactionCounts();
  const messages: ChatExportMessage[] = [];
  for (const line of input.lines) {
    const redacted = redactForShare(line.text, ctx);
    addRedactionCounts(counts, redacted.counts);
    const text = redacted.text.trim();
    if (text.length === 0) continue;
    messages.push({ role: line.kind === "user" ? "user" : "assistant", text });
  }
  const title = redactForShare(input.title, ctx);
  addRedactionCounts(counts, title.counts);
  return {
    title: cleanTitle(title.text),
    messages,
    exportedAt: input.exportedAt,
    ...(input.appVersion ? { appVersion: input.appVersion } : {}),
    counts,
  };
}

export function renderChatExport(chat: ChatExport, format: ChatExportFormat): string {
  return format === "md" ? renderChatMarkdown(chat) : renderChatHtml(chat);
}

export function renderChatMarkdown(chat: ChatExport): string {
  const parts = [`# ${chat.title}`, ""];
  for (const message of chat.messages) {
    parts.push(message.role === "user" ? "## You" : "## Atomic Agent", "", message.text, "");
  }
  parts.push("---", "", footerText(chat), "");
  return parts.join("\n");
}

export function renderChatHtml(chat: ChatExport): string {
  const body = chat.messages
    .map(
      (m) =>
        `<section class="msg ${m.role}"><h2>${m.role === "user" ? "You" : "Atomic Agent"}</h2>` +
        `<div class="text">${markdownToHtml(m.text)}</div></section>`,
    )
    .join("\n");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
    '<meta name="robots" content="noindex">',
    `<title>${escapeHtml(chat.title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    `<h1>${escapeHtml(chat.title)}</h1>`,
    body,
    `<footer>${escapeHtml(footerText(chat))}</footer>`,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function footerText(chat: ChatExport): string {
  const date = chat.exportedAt.toISOString().slice(0, 10);
  const app = chat.appVersion ? `Atomic Agent ${chat.appVersion}` : "Atomic Agent";
  return `Shared from ${app} on ${date}. Messages only: tool output, reasoning and local paths were removed.`;
}

function cleanTitle(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return FALLBACK_TITLE;
  return oneLine.length > MAX_TITLE_CHARS
    ? `${oneLine.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`
    : oneLine;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The small Markdown subset replies use most: fenced code blocks,
 * inline code, bold, headings and paragraphs with line breaks. Links
 * stay text: a shared page should not send its reader anywhere.
 */
export function markdownToHtml(text: string): string {
  const out: string[] = [];
  const blocks = text.replace(/\r\n?/g, "\n").split(/^```[^\n]*\n?/m);
  blocks.forEach((block, index) => {
    if (index % 2 === 1) {
      out.push(`<pre><code>${escapeHtml(block.replace(/\n$/, ""))}</code></pre>`);
      return;
    }
    for (const para of block.split(/\n{2,}/)) {
      const trimmed = para.trim();
      if (trimmed.length === 0) continue;
      const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
      if (heading && !trimmed.includes("\n")) {
        out.push(`<h3>${inline(heading[2] ?? "")}</h3>`);
        continue;
      }
      out.push(`<p>${trimmed.split("\n").map(inline).join("<br>")}</p>`);
    }
  });
  return out.join("\n");
}

function inline(line: string): string {
  return line
    .split(/(`[^`\n]+`)/)
    .map((piece) =>
      piece.length > 2 && piece.startsWith("`") && piece.endsWith("`")
        ? `<code>${escapeHtml(piece.slice(1, -1))}</code>`
        : escapeHtml(piece).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>"),
    )
    .join("");
}

const STYLE = [
  ":root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6b6b66;--card:#ffffff;--user:#eef3ff;--line:#e4e4df;--code:#f3f3f0}",
  "@media (prefers-color-scheme: dark){:root{--bg:#151514;--fg:#ececea;--muted:#9a9a94;--card:#1d1d1c;--user:#1f2635;--line:#2c2c2a;--code:#262624}}",
  "*{box-sizing:border-box}",
  "body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}",
  "main{max-width:760px;margin:0 auto;padding:32px 16px 48px}",
  "h1{font-size:1.5rem;margin:0 0 24px}",
  ".msg{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin:0 0 14px}",
  ".msg.user{background:var(--user)}",
  ".msg h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 6px}",
  ".text p{margin:0 0 10px;overflow-wrap:anywhere}",
  ".text h3{font-size:1rem;margin:12px 0 6px}",
  "pre{background:var(--code);border-radius:8px;padding:10px 12px;overflow-x:auto}",
  "code{font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);border-radius:4px;padding:0 3px}",
  "pre code{padding:0;background:none}",
  "footer{color:var(--muted);font-size:.85rem;margin-top:28px}",
].join("");
