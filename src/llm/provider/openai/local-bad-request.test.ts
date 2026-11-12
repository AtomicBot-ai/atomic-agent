import { describe, expect, it } from "vitest";

import { localBadRequestKind } from "./local-bad-request.js";
import { OpenAiHttpError, humanizeOpenAiHttpError } from "./openai-http.js";
import { parseProviderErrorBody } from "./parse-provider-error-body.js";
import { isRequestSizeRejection } from "../../reliability/request-size-rejection.js";

function http(status: number, url: string, rawBody: string, withBody = true): OpenAiHttpError {
  return new OpenAiHttpError(
    `openai provider ${status}: ${rawBody}`,
    status,
    url,
    false,
    null,
    "ollama",
    undefined,
    withBody ? { body: parseProviderErrorBody(rawBody) } : undefined,
  );
}

const CONTEXT_BODY = JSON.stringify({
  error: {
    code: 400,
    message: "the request exceeds the available context size, try increasing it",
    type: "exceed_context_size_error",
  },
});

const INVALID_BODY = JSON.stringify({
  error: { message: "Unknown role: tool", type: "invalid_request_error" },
});

describe("localBadRequestKind", () => {
  it("reads the two typed reasons on a 400 only", () => {
    expect(localBadRequestKind(400, "exceed_context_size_error")).toBe("context_exceeded");
    expect(localBadRequestKind(400, "invalid_request_error", "Unknown role: tool")).toBe("invalid_request");
    expect(
      localBadRequestKind(400, "invalid_request_error", "the request exceeds the available context size"),
    ).toBe("context_exceeded");
    expect(localBadRequestKind(400, undefined, "bad request")).toBeNull();
    expect(localBadRequestKind(400, "server_error")).toBeNull();
    expect(localBadRequestKind(413, "exceed_context_size_error")).toBeNull();
    expect(localBadRequestKind(null, "invalid_request_error")).toBeNull();
  });
});

describe("humanizeOpenAiHttpError: a typed 400 from a server on this machine (ATO-707, ATO-737)", () => {
  it("says the conversation outgrew the context window, and what to do", () => {
    const text = humanizeOpenAiHttpError(http(400, "http://localhost:11434/v1/chat/completions", CONTEXT_BODY));
    expect(text).toBe(
      "The local Ollama server at localhost:11434 turned the request down (400). " +
        "The conversation no longer fits in the local model's context window. " +
        "Compact this chat or start a new one, or give the model a larger context size.",
    );
    expect(text).not.toContain("—");
  });

  it("says the request was turned down as invalid and quotes the server", () => {
    const text = humanizeOpenAiHttpError(http(400, "http://127.0.0.1:1234/v1/chat/completions", INVALID_BODY));
    expect(text).toContain("The local server at 127.0.0.1:1234 turned the request down (400).");
    expect(text).toContain("may not support something the agent sent");
    expect(text).toContain("The server said: Unknown role: tool");
  });

  it("reads the type off the message when the error carries no parsed body", () => {
    const text = humanizeOpenAiHttpError(
      http(400, "http://127.0.0.1:1337/v1/chat/completions", CONTEXT_BODY, false),
    );
    expect(text).toContain("The local Atomic Chat server at 127.0.0.1:1337 turned the request down (400).");
    expect(text).toContain("context window");
  });

  it("keeps the old wording for an untyped local 400 and for a cloud 400", () => {
    expect(humanizeOpenAiHttpError(http(400, "http://127.0.0.1:1234/v1/chat/completions", "bad request"))).toBe(
      '"ollama" rejected the request (400). bad request',
    );
    expect(
      humanizeOpenAiHttpError(http(400, "https://api.example.com/v1/chat/completions", INVALID_BODY)),
    ).toBe('"ollama" rejected the request (400). Unknown role: tool');
  });
});

describe("Ollama's context overflow (ATO-1276)", () => {
  const OLLAMA_URL = "http://localhost:11434/v1/chat/completions";
  const PLAIN_STRING_BODY = JSON.stringify({ error: "prompt too long; exceeded max context length by 1873 tokens" });
  const API_ERROR_BODY = JSON.stringify({
    error: { message: "the input length exceeds the context length", type: "api_error", param: null, code: null },
  });
  const INVALID_TYPED_BODY = JSON.stringify({
    error: { message: "input exceeds maximum context length (4096 tokens)", type: "invalid_request_error" },
  });

  it("reads a plain-string or untyped body that says the context is full", () => {
    expect(localBadRequestKind(400, undefined, PLAIN_STRING_BODY)).toBe("context_exceeded");
    expect(localBadRequestKind(400, "api_error", API_ERROR_BODY)).toBe("context_exceeded");
    expect(localBadRequestKind(400, "invalid_request_error", INVALID_TYPED_BODY)).toBe("context_exceeded");
    expect(localBadRequestKind(400, undefined, "400 exceed_context_size")).toBe("context_exceeded");
  });

  it("keeps an untyped 400 that names no context reason unclassified", () => {
    expect(localBadRequestKind(400, undefined, JSON.stringify({ error: "model is required" }))).toBeNull();
    expect(localBadRequestKind(400, undefined, "the reply is too long for the screen")).toBeNull();
    expect(localBadRequestKind(500, undefined, PLAIN_STRING_BODY)).toBeNull();
  });

  it("says the conversation outgrew the window for each body shape", () => {
    for (const body of [PLAIN_STRING_BODY, API_ERROR_BODY, INVALID_TYPED_BODY]) {
      const text = humanizeOpenAiHttpError(http(400, OLLAMA_URL, body));
      expect(text).toContain("The local Ollama server at localhost:11434 turned the request down (400).");
      expect(text).toContain("no longer fits in the local model's context window");
    }
  });

  it("is a size rejection, so the overflow compaction runs", () => {
    for (const body of [PLAIN_STRING_BODY, API_ERROR_BODY, INVALID_TYPED_BODY]) {
      expect(isRequestSizeRejection(http(400, OLLAMA_URL, body))).toBe(true);
    }
  });
});
