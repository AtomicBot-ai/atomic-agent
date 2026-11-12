import { validatePlainCompleteInput } from "../runtime/plain-complete.js";
import { openaiError } from "./openai-errors.js";
import {
  onClientGone,
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";

/**
 * `POST /api/complete` — one plain request to the current model (ATO-875).
 *
 * Body: `{ prompt: string, system?: string, max_tokens?: number }`.
 * Reply: `{ text }`.
 *
 * No tools, no turn, no session: nothing reaches `sessions.sqlite` or the
 * sidebar. The call goes through `runtime.completePlain`, which routes it
 * the way a chat step is routed (local llama-server / Core, cloud key,
 * subscription, fallback chain); under Fusion that is the base model the
 * orchestrator runs on. `max_tokens` is clamped to the cap in
 * `plain-complete.ts`, and a default applies when it is absent.
 *
 * `400` for a bad body, `501` when the runtime offers no plain call,
 * `502` when the model failed or answered nothing, `504` on the deadline.
 * A client that disconnects aborts the call.
 */
export function createPlainCompleteHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody<Record<string, unknown>>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      sendError(res, 400, openaiError("body must be a JSON object"));
      return;
    }
    const invalid = validatePlainCompleteInput({
      prompt: body.prompt,
      system: body.system,
      maxTokens: body.max_tokens,
    });
    if (invalid !== null) {
      sendError(res, 400, openaiError(invalid));
      return;
    }
    if (!ctx.runtime.completePlain) {
      sendError(res, 501, openaiError("plain completion is not available in this runtime"));
      return;
    }
    const controller = new AbortController();
    onClientGone(res, () => controller.abort());
    const result = await ctx.runtime.completePlain({
      prompt: body.prompt as string,
      ...(typeof body.system === "string" ? { system: body.system } : {}),
      ...(typeof body.max_tokens === "number" ? { maxTokens: body.max_tokens } : {}),
      signal: controller.signal,
    });
    if (controller.signal.aborted || res.writableEnded) return;
    if (result.ok) {
      sendJson(res, 200, { text: result.text });
      return;
    }
    const status = result.kind === "invalid" ? 400 : result.kind === "timeout" ? 504 : 502;
    sendError(res, status, openaiError(result.reason, status === 400 ? "invalid_request_error" : "server_error"));
  };
}
