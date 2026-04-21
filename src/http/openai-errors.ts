/**
 * OpenAI-style error envelope. Mirrors hermes-agent `_openai_error` so
 * existing OpenAI SDKs surface the same shape. Used for every non-2xx
 * response emitted by the HTTP server — including atomic-specific
 * endpoints — to keep the error schema uniform across the whole surface.
 */
export interface OpenAiErrorPayload {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

export function openaiError(
  message: string,
  type = "invalid_request_error",
  param: string | null = null,
  code: string | null = null,
): OpenAiErrorPayload {
  return {
    error: {
      message,
      type,
      param,
      code,
    },
  };
}
