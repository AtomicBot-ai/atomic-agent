import {
  CHAT_EXPORT_MIME,
  chatExportFilename,
  chatExportTitle,
  renderChatHtml,
  renderChatMarkdown,
  type ChatExportFormat,
  type ChatExportOptions,
} from "./chat-export.js";
import { renderMarkdownDocx } from "./chat-export-docx.js";
import type { SessionState } from "./session-state.js";

/** One exported chat, ready to write to a file or send over the wire. */
export interface ChatExportFile {
  format: ChatExportFormat;
  filename: string;
  mimeType: string;
  /** Text for Markdown and HTML, bytes for DOCX. */
  body: string | Buffer;
}

/** `state` in `format`: the Markdown, or a document built from it. */
export async function exportChat(
  state: SessionState,
  format: ChatExportFormat,
  options: ChatExportOptions = {},
): Promise<ChatExportFile> {
  const now = options.now ?? Date.now();
  const markdown = renderChatMarkdown(state, { ...options, now });
  const title = chatExportTitle(state);
  const body =
    format === "markdown"
      ? markdown
      : format === "html"
        ? renderChatHtml(markdown, title)
        : await renderMarkdownDocx(markdown, title, now);
  return { format, filename: chatExportFilename(state, format), mimeType: CHAT_EXPORT_MIME[format], body };
}
