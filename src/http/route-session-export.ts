import { exportChat, parseChatExportFormat } from "../session/index.js";
import { describeToolCall } from "../tools/describe-tool-call.js";
import { openaiError } from "./openai-errors.js";
import { sendError, sendJson, type HttpHandler } from "./request-context.js";

/**
 * `GET /api/sessions/{id}/export?format=markdown|html|docx[&tools=0]` —
 * one chat as a document (ATO-1054).
 *
 * The answer is JSON, not the raw file, so a client that already speaks
 * JSON to this server needs nothing new to read it:
 * `{ id, format, filename, mimeType, encoding, content }`, where
 * `encoding` is `utf8` for Markdown and HTML and `base64` for DOCX. The
 * client writes `content` to wherever the person chose. PDF is the
 * client's job: it prints the `html` format (Electron `printToPDF`).
 *
 * `format` defaults to Markdown and also takes `md` / `word`; anything
 * else is `400`. `tools=0` leaves out the one-line-per-tool-step list.
 * `404` when the session is not persisted.
 */
export function createExportSessionHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("session id is required"));
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const format = parseChatExportFormat(url.searchParams.get("format"));
    if (!format) {
      sendError(res, 400, openaiError("format must be markdown, html or docx", "invalid_request_error", "format"));
      return;
    }
    const state = ctx.runtime.sessionStore.load(id);
    if (!state) {
      sendError(res, 404, openaiError(`session not found: ${id}`));
      return;
    }
    const file = await exportChat(state, format, {
      includeTools: url.searchParams.get("tools") !== "0",
      describeToolCall: (call) => describeToolCall({ name: call.tool, args: call.args, ok: call.ok }).line,
    });
    const binary = typeof file.body !== "string";
    sendJson(res, 200, {
      id: state.id,
      format: file.format,
      filename: file.filename,
      mimeType: file.mimeType,
      encoding: binary ? "base64" : "utf8",
      content: binary ? (file.body as Buffer).toString("base64") : file.body,
    });
  };
}
