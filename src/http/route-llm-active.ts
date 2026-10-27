import { getConfig, resetConfigCache } from "../config/index.js";
import {
  entryHasNoChatModel,
  resolveLlmConfig,
} from "../llm/provider/registry/index.js";
import {
  MODEL_PIN_IGNORED_KINDS,
  missingApiKey,
  switchActiveLlm,
} from "../channels/model-switch.js";

import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";

/**
 * `POST /api/llm/active` — `{ providerId, model? }`: make a provider (and
 * optionally a chat model on it) the active text route of the running
 * agent, without restarting `atag serve` (ATO-1021).
 *
 * The same legs as `/model` in the chat channels (model-switch.ts): pin
 * the model, rebuild the provider from the config, make it active,
 * persist, roll back on failure. The config cache is dropped first, so a
 * client that already wrote the file (the desktop does) is switched onto
 * what the file now says.
 *
 * `409` while any session has a turn running: the provider is shared, and
 * a switch would land under those turns at their next step. The caller
 * waits, or falls back to its own restart.
 */
export function createSetActiveLlmHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let body: unknown;
    try {
      body = await readJsonBody<unknown>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    const parsed = parseBody(body);
    if (typeof parsed === "string") {
      sendError(res, 400, openaiError(parsed));
      return;
    }
    const busy = ctx.runtime.turnController.busySessionIds().length;
    if (busy > 0) {
      sendError(
        res,
        409,
        openaiError(
          `${busy} turn${busy === 1 ? " is" : "s are"} in progress; switch the model when ${busy === 1 ? "it finishes" : "they finish"}`,
          "invalid_request_error",
          null,
          "turn_in_progress",
        ),
      );
      return;
    }
    const startedAt = Date.now();
    resetConfigCache();
    const config = getConfig();
    const entry = resolveLlmConfig(config).providers.find(
      (p) => p.id === parsed.providerId,
    );
    if (!entry) {
      sendError(
        res,
        404,
        openaiError(`provider ${JSON.stringify(parsed.providerId)} is not configured`),
      );
      return;
    }
    const refusal = refusalFor(entry, parsed.modelId, config);
    if (refusal) {
      sendError(res, 400, openaiError(refusal));
      return;
    }
    const outcome = await switchActiveLlm(ctx.runtime, {
      providerId: entry.id,
      modelId: parsed.modelId,
      previousActiveId: ctx.runtime.providerRegistry.activeTextProviderId,
    });
    if (!outcome.ok) {
      sendError(
        res,
        500,
        openaiError(`could not switch to ${entry.id}: ${outcome.error}`, "server_error"),
      );
      return;
    }
    const after = resolveLlmConfig(getConfig()).providers.find(
      (p) => p.id === entry.id,
    );
    sendJson(res, 200, {
      ok: true,
      providerId: entry.id,
      model: after?.defaultChatModel ?? after?.model ?? null,
      ms: Date.now() - startedAt,
    });
  };
}

function parseBody(
  body: unknown,
): { providerId: string; modelId: string | null } | string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return "body must be a JSON object";
  }
  const { providerId, model } = body as Record<string, unknown>;
  if (typeof providerId !== "string" || providerId.trim().length === 0) {
    return "providerId is required";
  }
  if (model !== undefined && model !== null && typeof model !== "string") {
    return "model must be a string";
  }
  const modelId = typeof model === "string" ? model.trim() : null;
  if (modelId !== null && modelId.length === 0) return "model is empty";
  return { providerId: providerId.trim(), modelId };
}

/** The `/model` refusals, worded for an API caller. */
function refusalFor(
  entry: Parameters<typeof missingApiKey>[0],
  modelId: string | null,
  config: Parameters<typeof missingApiKey>[1],
): string | null {
  const missing = missingApiKey(entry, config);
  if (missing) {
    return `provider ${entry.id} has no API key configured${
      missing.envVar === null ? "" : ` (${missing.envVar} is unset)`
    }`;
  }
  if (modelId === null && entryHasNoChatModel(entry)) {
    return `provider ${entry.id} has no chat model; pass one in "model"`;
  }
  if (modelId !== null && MODEL_PIN_IGNORED_KINDS.has(entry.kind)) {
    return `provider ${entry.id} is a local ${entry.kind} provider; it serves the model its daemon loaded and takes no "model"`;
  }
  return null;
}
