import { describe, expect, it } from "vitest";

import { LlamaServerError, extractLlamaErrorDetail, readLlamaErrorBody } from "../llama-server-client.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { parseProviderErrorBody } from "../provider/openai/parse-provider-error-body.js";
import { GrammarError, TransportError } from "./llm-failures.js";
import { ATOMIC_CHAT_KEY_ADVICE } from "../provider/openai/atomic-chat-key.js";
import { LOCAL_PORT_TAKEN_ADVICE, LOCAL_PORT_TAKEN_CODE, LOCAL_PORT_TAKEN_MESSAGE, LocalPortTakenError } from "./local-port-taken.js";
import {
  ATOMIC_CHAT_KEY_REQUIRED_CODE,
  isUnreportedLocalServerFailure,
  LOCAL_CONTEXT_EXCEEDED_CODE,
  LOCAL_PROVIDER_NOT_FOUND_CODE,
  LOCAL_REQUEST_INVALID_CODE,
  LOCAL_SERVER_NOT_FOUND_ADVICE,
  LOCAL_SERVER_NOT_FOUND_CODE,
  LOCAL_SERVER_NOT_FOUND_MESSAGE,
  LOCAL_SERVER_RECHECK_HINT,
  LOCAL_TOOLS_UNSUPPORTED_CODE,
  classifyLocalServerError,
  localServerErrorLines,
} from "./local-server-error.js";

const CONTEXT_BODY = JSON.stringify({
  error: {
    code: 400,
    message: "request (5369 tokens) exceeds the available context size (4096 tokens), try increasing it",
    type: "exceed_context_size_error",
  },
});

const INVALID_BODY = JSON.stringify({
  error: { code: 400, message: "Unknown role: tool", type: "invalid_request_error" },
});

/** llama-server started without --jinja (ATO-1209). */
const JINJA_BODY = JSON.stringify({
  error: { code: 400, message: "tools param requires --jinja flag", type: "invalid_request_error" },
});

/** A llama-server HTTP error the way `buildHttpError` makes one: the body's words folded into the message. */
function llamaHttp(status: number, url: string, rawBody = ""): LlamaServerError {
  const body = readLlamaErrorBody(rawBody);
  const detail = extractLlamaErrorDetail(rawBody);
  return new LlamaServerError(
    detail ? `llama-server returned http ${status}: ${detail}` : `llama-server returned http ${status}`,
    status,
    url,
    false,
    undefined,
    body !== undefined ? { body } : undefined,
  );
}

/** An OpenAI-compatible HTTP error the way `openAiFetch` makes one. */
function openAiHttp(status: number, url: string, rawBody: string): OpenAiHttpError {
  return new OpenAiHttpError(
    `openai provider ${status}: ${rawBody}`,
    status,
    url,
    false,
    null,
    "lmstudio",
    undefined,
    { body: parseProviderErrorBody(rawBody) },
  );
}

describe("classifyLocalServerError: 404/405 on the llama.cpp route (ATO-708)", () => {
  it("says the address is not a model server, for both statuses", () => {
    for (const status of [404, 405]) {
      const verdict = classifyLocalServerError(
        llamaHttp(status, "http://127.0.0.1:9931/v1/chat/completions"),
      );
      expect(verdict).toEqual({
        code: LOCAL_SERVER_NOT_FOUND_CODE,
        status,
        url: "http://127.0.0.1:9931/v1/chat/completions",
        message: LOCAL_SERVER_NOT_FOUND_MESSAGE,
        advice: LOCAL_SERVER_NOT_FOUND_ADVICE,
      });
    }
  });

  it("names 9931 for an address on the old 8080 default", () => {
    const verdict = classifyLocalServerError(
      llamaHttp(404, "http://127.0.0.1:8080/v1/chat/completions"),
    );
    expect(verdict?.code).toBe(LOCAL_SERVER_NOT_FOUND_CODE);
    expect(verdict?.advice).toContain("9931");
    expect(verdict?.advice).toContain("8080");
  });

  it("finds the error under the agent loop's wrapper", () => {
    const raw = llamaHttp(404, "http://127.0.0.1:9931/completion");
    const wrapped = new TransportError(raw.message, 404, raw.url, { cause: raw });
    expect(classifyLocalServerError(wrapped)?.code).toBe(LOCAL_SERVER_NOT_FOUND_CODE);
  });

  it("gives the terminal the recheck command", () => {
    const verdict = classifyLocalServerError(
      llamaHttp(404, "http://127.0.0.1:9931/v1/chat/completions"),
    );
    expect(localServerErrorLines(verdict!)).toEqual([
      `${LOCAL_SERVER_NOT_FOUND_MESSAGE} ${LOCAL_SERVER_NOT_FOUND_ADVICE}`,
      LOCAL_SERVER_RECHECK_HINT,
    ]);
    expect(LOCAL_SERVER_RECHECK_HINT).toBe("Recheck the address with: atomic-agent models check");
  });
});

describe("classifyLocalServerError: 400 from a local server (ATO-707, ATO-737)", () => {
  it("reads llama.cpp's exceed_context_size_error as a full context", () => {
    const raw = llamaHttp(400, "http://127.0.0.1:9931/v1/chat/completions", CONTEXT_BODY);
    const verdict = classifyLocalServerError(new GrammarError(raw.message, "", { cause: raw }));
    expect(verdict?.code).toBe(LOCAL_CONTEXT_EXCEEDED_CODE);
    expect(verdict?.status).toBe(400);
    expect(verdict?.message).toContain("context window");
    expect(verdict?.advice).toContain("Compact this chat");
  });

  it("reads an older build's invalid_request_error about context size as a full context", () => {
    const body = JSON.stringify({
      error: { message: "the request exceeds the available context size, try increasing it", type: "invalid_request_error" },
    });
    const verdict = classifyLocalServerError(openAiHttp(400, "http://127.0.0.1:1234/v1/chat/completions", body));
    expect(verdict?.code).toBe(LOCAL_CONTEXT_EXCEEDED_CODE);
  });

  it("reads any other invalid_request_error as a request the server would not accept", () => {
    for (const err of [
      llamaHttp(400, "http://127.0.0.1:9931/v1/chat/completions", INVALID_BODY),
      openAiHttp(400, "http://localhost:11434/v1/chat/completions", INVALID_BODY),
    ]) {
      const verdict = classifyLocalServerError(err);
      expect(verdict?.code).toBe(LOCAL_REQUEST_INVALID_CODE);
      expect(verdict?.message).toBe("The local model server turned the request down as invalid.");
      expect(localServerErrorLines(verdict!)).toHaveLength(1);
    }
  });

  it("reads a server that takes no tool calls as local_tools_unsupported (ATO-1209)", () => {
    const ollamaString = JSON.stringify({ error: "registry.ollama.ai/library/gemma2:2b does not support tools" });
    const jinja = "Start llama-server with --jinja, or pick a model that supports tools.";
    const model = "Pick a model that supports tools, or turn on tool calling in the server.";
    for (const [err, advice] of [
      // llama.cpp: typed body, the words in the message.
      [llamaHttp(400, "http://127.0.0.1:9931/v1/chat/completions", JINJA_BODY), jinja],
      // The same through the OpenAI-compatible client, wrapped the way the loop wraps it.
      [new TransportError("x", 400, "http://127.0.0.1:9931/v1/chat/completions", {
        cause: openAiHttp(400, "http://127.0.0.1:9931/v1/chat/completions", JINJA_BODY),
      }), jinja],
      // Ollama: a plain string `error`, no type, and no word of --jinja:
      // it must not be told to restart llama-server.
      [openAiHttp(400, "http://localhost:11434/v1/chat/completions", ollamaString), model],
      [openAiHttp(400, "http://localhost:11434/v1/chat/completions", "tool(s) not supported"), model],
    ] as const) {
      const verdict = classifyLocalServerError(err);
      expect(verdict?.code).toBe(LOCAL_TOOLS_UNSUPPORTED_CODE);
      expect(verdict?.status).toBe(400);
      expect(verdict?.message).toBe("This local server doesn't accept tool calls.");
      expect(verdict?.advice).toBe(advice);
      expect(verdict?.advice.includes("--jinja")).toBe(advice === jinja);
      expect(localServerErrorLines(verdict!)).toHaveLength(1);
    }
  });

  it("does not read tool wording from a cloud provider or a non-400", () => {
    const body = JSON.stringify({ error: "model does not support tools" });
    expect(classifyLocalServerError(openAiHttp(400, "https://api.example.com/v1/chat/completions", body))).toBeNull();
    expect(classifyLocalServerError(openAiHttp(500, "http://localhost:11434/v1/chat/completions", body))).toBeNull();
  });

  it("leaves a bare 400 with no reason in its body alone", () => {
    expect(classifyLocalServerError(llamaHttp(400, "http://127.0.0.1:9931/completion"))).toBeNull();
    expect(
      classifyLocalServerError(openAiHttp(400, "http://127.0.0.1:1234/v1/chat/completions", "bad request")),
    ).toBeNull();
  });
});

describe("classifyLocalServerError: what it leaves alone", () => {
  it("ignores a cloud provider's 400 and every OpenAI-compatible 404", () => {
    expect(
      classifyLocalServerError(openAiHttp(400, "https://openrouter.ai/api/v1/chat/completions", INVALID_BODY)),
    ).toBeNull();
    expect(
      classifyLocalServerError(openAiHttp(404, "http://127.0.0.1:1337/v1/chat/completions", "{}")),
    ).toBeNull();
  });

  it("ignores other statuses, transport failures and timeouts", () => {
    expect(classifyLocalServerError(llamaHttp(500, "http://127.0.0.1:9931/completion"))).toBeNull();
    expect(classifyLocalServerError(llamaHttp(401, "http://127.0.0.1:9931/completion"))).toBeNull();
    expect(
      classifyLocalServerError(new LlamaServerError("fetch failed", null, "http://127.0.0.1:9931/completion")),
    ).toBeNull();
    expect(
      classifyLocalServerError(new LlamaServerError("timed out", 404, "http://127.0.0.1:9931/completion", true)),
    ).toBeNull();
    expect(classifyLocalServerError(new Error("llama-server returned http 404"))).toBeNull();
    expect(classifyLocalServerError("not an error")).toBeNull();
  });
});

describe("classifyLocalServerError: which address Reconnect would check", () => {
  const err = (url: string) => llamaHttp(404, url);

  it("keeps local_server_not_found when the error is at localModels.url", () => {
    expect(
      classifyLocalServerError(err("http://127.0.0.1:9931/v1/chat/completions"), {
        llamaUrl: "http://127.0.0.1:9931",
      })?.code,
    ).toBe(LOCAL_SERVER_NOT_FOUND_CODE);
  });

  it("says local_provider_not_found for another address, or an unknown one", () => {
    expect(
      classifyLocalServerError(err("http://127.0.0.1:8090/completion"), { llamaUrl: "http://127.0.0.1:9931" })?.code,
    ).toBe(LOCAL_PROVIDER_NOT_FOUND_CODE);
    expect(
      classifyLocalServerError(err("http://127.0.0.1:9931/completion"), { llamaUrl: null })?.code,
    ).toBe(LOCAL_PROVIDER_NOT_FOUND_CODE);
    expect(
      classifyLocalServerError(err("http://127.0.0.1:9931/completion"), { llamaUrl: "not a url" })?.code,
    ).toBe(LOCAL_PROVIDER_NOT_FOUND_CODE);
  });

  it("gives no recheck line for local_provider_not_found", () => {
    const verdict = classifyLocalServerError(err("http://127.0.0.1:8090/completion"), {
      llamaUrl: "http://127.0.0.1:9931",
    });
    expect(localServerErrorLines(verdict!)).toHaveLength(1);
  });
});

describe("classifyLocalServerError: OpenAI-compatible guards", () => {
  it("ignores a local 400 that timed out or was reported inside an open stream", () => {
    const url = "http://127.0.0.1:1234/v1/chat/completions";
    const timedOut = new OpenAiHttpError(
      `openai provider 400: ${INVALID_BODY}`,
      400,
      url,
      true,
      null,
      "lmstudio",
      undefined,
      { body: parseProviderErrorBody(INVALID_BODY) },
    );
    const inStream = new OpenAiHttpError(
      "stream error",
      400,
      url,
      false,
      null,
      "lmstudio",
      undefined,
      { body: parseProviderErrorBody(INVALID_BODY), streamError: "invalid request" },
    );
    expect(classifyLocalServerError(timedOut)).toBeNull();
    expect(classifyLocalServerError(inStream)).toBeNull();
  });
});

/** A 401/403 from an OpenAI-compatible provider the way `httpErrorFromResponse` makes one. */
function keyRefusal(
  status: 401 | 403,
  label: string,
  url: string,
  keyProblem?: "missing" | "non_ascii",
): OpenAiHttpError {
  return new OpenAiHttpError(
    `openai provider ${status}: {"error":"Unauthorized"}`,
    status,
    url,
    false,
    null,
    label,
    undefined,
    {
      body: parseProviderErrorBody('{"error":"Unauthorized"}'),
      ...(keyProblem !== undefined ? { keyProblem } : {}),
    },
  );
}

describe("classifyLocalServerError: Atomic Chat's API key protection (ATO-1274)", () => {
  const URL = "http://127.0.0.1:1337/v1/chat/completions";

  it("a 401 or 403 from the atomic-chat provider is atomic_chat_key_required, with its words", () => {
    for (const status of [401, 403] as const) {
      const verdict = classifyLocalServerError(keyRefusal(status, "atomic-chat", URL));
      expect(verdict).toEqual({
        code: ATOMIC_CHAT_KEY_REQUIRED_CODE,
        status,
        url: URL,
        message: `Atomic Chat answered ${status}: its API key protection is on and it refused the agent's key.`,
        advice: ATOMIC_CHAT_KEY_ADVICE,
      });
    }
  });

  it("says the agent has no key when it sent none", () => {
    const verdict = classifyLocalServerError(keyRefusal(401, "atomic-chat", URL, "missing"));
    expect(verdict?.code).toBe(ATOMIC_CHAT_KEY_REQUIRED_CODE);
    expect(verdict?.message).toBe("Atomic Chat answered 401: its API key protection is on and the agent has no key for it.");
  });

  it("names the provider's API key and Atomic Chat's own setting", () => {
    expect(ATOMIC_CHAT_KEY_ADVICE).toContain("Providers panel");
    expect(ATOMIC_CHAT_KEY_ADVICE).toContain("ATOMIC_CHAT_API_KEY");
    expect(ATOMIC_CHAT_KEY_ADVICE).toContain("Local API Server");
  });

  it("is found under the agent loop's wrapper", () => {
    const wrapped = new TransportError("wrapped", 401, URL, { cause: keyRefusal(401, "atomic-chat", URL) });
    expect(classifyLocalServerError(wrapped)?.code).toBe(ATOMIC_CHAT_KEY_REQUIRED_CODE);
  });

  it("a key that could not be sent (non-ASCII) keeps its own words", () => {
    expect(classifyLocalServerError(keyRefusal(401, "atomic-chat", URL, "non_ascii"))).toBeNull();
  });

  it("other providers' 401/403 are unchanged, local or not", () => {
    expect(classifyLocalServerError(keyRefusal(401, "lmstudio", "http://127.0.0.1:1234/v1/chat/completions"))).toBeNull();
    expect(classifyLocalServerError(keyRefusal(401, "ollama", "http://127.0.0.1:11434/v1/chat/completions"))).toBeNull();
    expect(classifyLocalServerError(keyRefusal(403, "openrouter", "https://openrouter.ai/api/v1/chat/completions"))).toBeNull();
  });

  it("is kept out of Sentry; other local-server codes are not", () => {
    expect(isUnreportedLocalServerFailure(keyRefusal(401, "atomic-chat", URL))).toBe(true);
    expect(isUnreportedLocalServerFailure(keyRefusal(401, "lmstudio", "http://127.0.0.1:1234/v1/chat/completions"))).toBe(false);
    expect(isUnreportedLocalServerFailure(llamaHttp(404, "http://127.0.0.1:9931/completion"))).toBe(false);
    expect(isUnreportedLocalServerFailure(new LocalPortTakenError("local-llama", "http://127.0.0.1:9931/completion"))).toBe(false);
    expect(isUnreportedLocalServerFailure(new Error("boom"))).toBe(false);
  });
});

describe("classifyLocalServerError: the managed port held by another program (ATO-1277)", () => {
  const URL = "http://127.0.0.1:9931/completion";

  it("a LocalPortTakenError is local_port_taken, before the 401 it wraps", () => {
    const refusal = llamaHttp(401, URL);
    const taken = new LocalPortTakenError("local-llama", URL, new TransportError("wrapped", 401, URL, { cause: refusal }));
    expect(classifyLocalServerError(taken)).toEqual({
      code: LOCAL_PORT_TAKEN_CODE,
      status: 401,
      url: URL,
      message: LOCAL_PORT_TAKEN_MESSAGE,
      advice: LOCAL_PORT_TAKEN_ADVICE,
    });
  });

  it("a bare llama-server 401 still has no code (the engine reading decides, not the status)", () => {
    expect(classifyLocalServerError(llamaHttp(401, URL))).toBeNull();
  });

  it("the advice names the real port setting and no command", () => {
    expect(LOCAL_PORT_TAKEN_ADVICE).toContain("localModels.managed.port");
    expect(LOCAL_PORT_TAKEN_ADVICE).not.toContain("atomic-agent");
  });
});
