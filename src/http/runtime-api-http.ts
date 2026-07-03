import type { ServerResponse } from "node:http";

import { RuntimeApiError, runtimeApiErrorStatus } from "../runtime-api/index.js";

import { openaiError } from "./openai-errors.js";
import { sendError } from "./request-context.js";

/**
 * Translate a `RuntimeApiError` from the shared runtime-facade into the
 * OpenAI-style HTTP error envelope. Returns `true` when the error was a
 * `RuntimeApiError` and a response was sent; `false` otherwise so the
 * caller can rethrow unexpected errors.
 */
export function sendRuntimeApiError(
  res: ServerResponse,
  err: unknown,
): err is RuntimeApiError {
  if (!(err instanceof RuntimeApiError)) return false;
  const status = runtimeApiErrorStatus(err.code);
  sendError(
    res,
    status,
    openaiError(err.message, "invalid_request_error", err.field ?? null, err.code),
  );
  return true;
}
