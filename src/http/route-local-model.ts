import { anthropicError } from "./anthropic-messages.js";
import { forwardToModel, readBodyUpTo, upstreamV1Url } from "./model-forward.js";
import { openaiError } from "./openai-errors.js";
import { BodyTooLargeError, sendJson, type HttpHandler } from "./request-context.js";
import { defaultRawModelShareDeps, type RawModelUpstream } from "./route-raw-model.js";

/**
 * ATO-2447: the bare local model for a coding CLI that `atag launch`
 * starts (Claude Code, Codex, OpenCode, ...).
 *
 * `/v1/messages`, `/v1/responses` and `/v1/chat/completions` on serve run
 * an Atomic Agent turn: the agent answers with its own tools and the CLI's
 * `tools` never reach the model. These routes run nothing of the agent.
 * They pass the CLI's request, tools and all, to the local model server the
 * agent uses (`localModels.url`: the managed llama-server or the one Atomic
 * Core loaded), add that server's private key, and stream its answer back
 * unchanged, so `tool_use` / `tool_calls` come back and the CLI runs its
 * own tools. llama-server speaks all three APIs itself (OpenAI chat
 * completions and Responses, Anthropic Messages). The precedent is
 * `ollama launch claude`, which points Claude Code at Ollama's own
 * Anthropic-compatible API, and LM Studio's `/v1/messages`.
 *
 * Unlike the share routes (`/raw/v1`), these sit behind the serve key and
 * the named tokens like every other authenticated route, are always on,
 * and do not limit requests to one at a time: a coding CLI sends a title
 * or a token count next to the main request, and the model server queues
 * them itself.
 */

export const LOCAL_MODEL_PREFIX = "/local/v1";

/**
 * Body cap for these routes: a CLI sends its whole conversation and tool
 * list every turn, far past the 1 MiB of the agent routes.
 */
export const LOCAL_MODEL_MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface LocalModelDeps {
  /** Where the model is now. */
  upstream: () => RawModelUpstream;
  fetch?: typeof fetch;
}

export interface LocalModelHandlers {
  models: HttpHandler;
  chatCompletions: HttpHandler;
  responses: HttpHandler;
  messages: HttpHandler;
  countTokens: HttpHandler;
}

type Dialect = "openai" | "anthropic";

const NOT_RUNNING = "The local model is not running. Start it with `atag models start` or in the Atomic Agent app, then try again.";

function errorBody(dialect: Dialect, status: number, message: string, code: string): unknown {
  return dialect === "anthropic" ? anthropicError(status, message) : openaiError(message, status >= 500 ? "server_error" : "invalid_request_error", null, code);
}

export function createLocalModelHandlers(deps: LocalModelDeps = { upstream: defaultRawModelShareDeps().upstream }): LocalModelHandlers {
  const doFetch = deps.fetch ?? fetch;

  const handle = (method: "GET" | "POST", path: string, dialect: Dialect): HttpHandler => async (req, res) => {
    let body: Buffer | undefined;
    if (method === "POST") {
      try {
        body = await readBodyUpTo(req, LOCAL_MODEL_MAX_BODY_BYTES);
      } catch (err) {
        if (!(err instanceof BodyTooLargeError)) throw err;
        const mib = LOCAL_MODEL_MAX_BODY_BYTES / (1024 * 1024);
        sendJson(res, 413, errorBody(dialect, 413, `The request is larger than ${mib} MiB`, "payload_too_large"));
        return;
      }
    }
    const target = deps.upstream();
    await forwardToModel(req, res, {
      method,
      url: upstreamV1Url(target.baseUrl, path),
      upstreamKey: target.apiKey,
      body,
      doFetch,
      unreachable: errorBody(dialect, 502, NOT_RUNNING, "model_unreachable"),
      notFound: errorBody(
        dialect,
        404,
        `The local model engine does not answer ${path} (an older build). Update it with \`atag models update\`, or use a CLI that speaks chat completions.`,
        "endpoint_unsupported",
      ),
    });
  };

  return {
    models: handle("GET", "/models", "openai"),
    chatCompletions: handle("POST", "/chat/completions", "openai"),
    responses: handle("POST", "/responses", "openai"),
    messages: handle("POST", "/messages", "anthropic"),
    countTokens: handle("POST", "/messages/count_tokens", "anthropic"),
  };
}
