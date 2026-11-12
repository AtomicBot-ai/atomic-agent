/**
 * A chat as one shareable file, redacted (ATO-581). See
 * `chat-export-render.ts` for what goes in and `chat-export-redact.ts`
 * for what is taken out.
 */

export {
  addRedactionCounts,
  emptyRedactionCounts,
  redactForShare,
  type ShareRedactionContext,
  type ShareRedactionCounts,
} from "./chat-export-redact.js";
export {
  buildChatExport,
  escapeHtml,
  markdownToHtml,
  renderChatExport,
  renderChatHtml,
  renderChatMarkdown,
  type ChatExport,
  type ChatExportFormat,
  type ChatExportInput,
  type ChatExportLine,
  type ChatExportMessage,
} from "./chat-export-render.js";
