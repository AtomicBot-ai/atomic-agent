/**
 * Outbound formatting for Matrix: the plain `body` every client shows,
 * plus an `org.matrix.custom.html` `formatted_body` for clients that
 * render HTML (Element, FluffyChat, Cinny).
 *
 * The HTML comes from the Telegram converter on purpose: its whitelist
 * (`b`, `i`, `s`, `u`, `code`, `pre`, `a`, `blockquote`) is a subset of
 * what the Matrix spec allows, it escapes every non-tag character and
 * refuses `javascript:` links. What Telegram does and Matrix HTML does
 * not is keep raw newlines, so they become `<br>` outside `<pre>`.
 */

import { convertMarkdownToTelegramHtml } from "../telegram/markdown-to-html.js";

export interface MatrixMessageContent {
  msgtype: "m.text" | "m.notice";
  body: string;
  format?: "org.matrix.custom.html";
  formatted_body?: string;
}

/**
 * `m.text` with HTML when the converter produced any markup; plain
 * otherwise, so a reply with no markdown is not sent twice over.
 */
export function formatMatrixMessage(text: string): MatrixMessageContent {
  let html: string;
  try {
    html = markdownToMatrixHtml(text);
  } catch {
    return { msgtype: "m.text", body: text };
  }
  if (!/[<&]/.test(html)) return { msgtype: "m.text", body: text };
  return {
    msgtype: "m.text",
    body: text,
    format: "org.matrix.custom.html",
    formatted_body: html,
  };
}

/**
 * Infrastructure lines (help, status, approval prompts, errors) go out
 * as `m.notice`: the spec's "automated message" type, which other bots
 * must not answer. Plain text, no HTML.
 */
export function formatMatrixNotice(text: string): MatrixMessageContent {
  return { msgtype: "m.notice", body: text };
}

export function markdownToMatrixHtml(markdown: string): string {
  const html = convertMarkdownToTelegramHtml(markdown);
  // Split on <pre>…</pre> so code keeps its line breaks verbatim.
  return html
    .split(/(<pre>[\s\S]*?<\/pre>)/)
    .map((part) => (part.startsWith("<pre>") ? part : part.replace(/\n/g, "<br>")))
    .join("");
}
