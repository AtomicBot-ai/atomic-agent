import { getConfig } from "../config/index.js";
import { contextUsageFromPrompt } from "../tui/context-usage-from-prompt.js";
import type { BuiltPrompt } from "../prompt/build-prompt-types.js";
import { effectiveReplyReserve } from "../prompt/token-budget.js";
import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";

/**
 * `POST /api/context-preview` — the composer's context readout BEFORE
 * a message is sent, over HTTP.
 *
 * The TUI shows nothing until the loop emits `prompt_built`; a desktop
 * client wants the figure while the operator is still typing. Rather
 * than let the client estimate, the runtime builds — never runs, never
 * persists — the prompt the next turn would open with
 * (`runtime.previewPrompt`) and reports it through the TUI's own
 * projection, `contextUsageFromPrompt`, so the section labels and the
 * arithmetic are the ones the TUI's panel uses after the first turn.
 *
 * Body: `{ session_id?: string, message?: string }`. No `session_id`
 * previews a fresh thread in this workspace; `message` is the draft,
 * counted as the user message. Reply: `{ basis: "built", usage,
 * contextWindow, reservedForReply, replyCap, pairsCap }` — `basis` says
 * what this is, because no recall / memory-index prefetch runs here
 * (those rows appear only after a real turn). `replyCap` is
 * `config.localModels.completionMaxTokens`, what the TUI panel is handed
 * as `reservedForReply`; `reservedForReply` is the part of it the prompt
 * budget really holds back on this window (`effectiveReplyReserve`, the
 * figure `computeEffectiveConversationCap` subtracts) — a 96k cap on a
 * 32k window is not a 96k reservation. A panel drawing it still clamps it
 * to what the prompt left of the window (the TUI's `replyReserveShown`,
 * the desktop's `ctxReplyReserve`), so it can show less than this.
 * 404 for an unknown session, 400 for a bad body.
 */
export function createContextPreviewHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let body: { session_id?: unknown; message?: unknown };
    try {
      body = await readJsonBody<{ session_id?: unknown; message?: unknown }>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    if (body.session_id !== undefined && typeof body.session_id !== "string") {
      sendError(res, 400, openaiError("session_id must be a string"));
      return;
    }
    if (body.message !== undefined && typeof body.message !== "string") {
      sendError(res, 400, openaiError("message must be a string"));
      return;
    }
    const sessionId = body.session_id && body.session_id.length > 0 ? body.session_id : null;
    let prompt: BuiltPrompt;
    try {
      prompt = ctx.runtime.previewPrompt({
        sessionId,
        ...(typeof body.message === "string" ? { userMessage: body.message } : {}),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "SessionNotFoundError") {
        sendError(res, 404, openaiError(err.message));
        return;
      }
      throw err;
    }
    sendJson(res, 200, {
      basis: "built",
      usage: contextUsageFromPrompt(prompt),
      contextWindow: prompt.contextWindow,
      reservedForReply: effectiveReplyReserve(
        getConfig().localModels.completionMaxTokens,
        prompt.contextWindow,
      ),
      replyCap: getConfig().localModels.completionMaxTokens,
      pairsCap: prompt.conversationPairsCap,
    });
  };
}
