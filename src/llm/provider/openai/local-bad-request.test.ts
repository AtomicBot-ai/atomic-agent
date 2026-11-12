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

  it("reads a server that takes no tool calls, typed body or not (ATO-1209)", () => {
    // llama-server started without --jinja: a typed invalid_request_error.
    expect(localBadRequestKind(400, "invalid_request_error", "tools param requires --jinja flag")).toBe(
      "tools_unsupported",
    );
    expect(localBadRequestKind(400, "invalid_request_error", "tool_choice param requires --jinja flag")).toBe(
      "tools_unsupported",
    );
    // Ollama: a plain string `error`, so no type at all.
    expect(
      localBadRequestKind(400, undefined, '{"error":"registry.ollama.ai/library/gemma2:2b does not support tools"}'),
    ).toBe("tools_unsupported");
    expect(localBadRequestKind(400, undefined, "tool(s) not supported")).toBe("tools_unsupported");
    expect(localBadRequestKind(400, undefined, "Tools are not supported by this model")).toBe("tools_unsupported");
    // A full context still wins, and other statuses stay untouched.
    expect(localBadRequestKind(400, "exceed_context_size_error", "tools param requires --jinja flag")).toBe(
      "context_exceeded",
    );
    expect(localBadRequestKind(500, undefined, "does not support tools")).toBeNull();
  });

  it("leaves other bare 400s and near-miss wording alone", () => {
    expect(localBadRequestKind(400, undefined, "")).toBeNull();
    expect(localBadRequestKind(400, undefined, "Unknown role: tool")).toBeNull();
    // The native message shape refused: the provider falls back from it on its own.
    expect(localBadRequestKind(400, undefined, "tool_calls is not supported")).toBeNull();
    expect(localBadRequestKind(400, undefined, "image input is not supported for this model")).toBeNull();
    expect(localBadRequestKind(400, "invalid_request_error", "Unknown role: tool")).toBe("invalid_request");
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

  it("says llama-server takes no tool calls without --jinja, and what to do (ATO-1209)", () => {
    const body = JSON.stringify({
      error: { code: 400, message: "tools param requires --jinja flag", type: "invalid_request_error" },
    });
    const text = humanizeOpenAiHttpError(http(400, "http://127.0.0.1:9931/v1/chat/completions", body));
    expect(text).toBe(
      "The local server at 127.0.0.1:9931 turned the request down (400). " +
        "This local server doesn't accept tool calls. " +
        "Start llama-server with --jinja, or pick a model that supports tools. " +
        "The server said: tools param requires --jinja flag",
    );
  });

  it("reads Ollama's plain string error about tools, though it has no type (ATO-1209)", () => {
    const body = JSON.stringify({ error: "registry.ollama.ai/library/gemma2:2b does not support tools" });
    for (const withBody of [true, false]) {
      const text = humanizeOpenAiHttpError(http(400, "http://localhost:11434/v1/chat/completions", body, withBody));
      expect(text).toContain("The local Ollama server at localhost:11434 turned the request down (400).");
      expect(text).toContain("This local server doesn't accept tool calls.");
      expect(text).toContain("Pick a model that supports tools, or turn on tool calling in the server.");
      // Ollama is not llama-server: no --jinja advice (the server's own
      // words are quoted after "The server said:", and name no flag).
      expect(text).not.toContain("--jinja");
    }
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
