import { describe, expect, it } from "vitest";

import { LlamaServerError, readLlamaErrorBody } from "../llama-server-client.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { parseProviderErrorBody } from "../provider/openai/parse-provider-error-body.js";
import { GrammarError, TransportError } from "./llm-failures.js";
import {
  LOCAL_CONTEXT_EXCEEDED_CODE,
  LOCAL_PROVIDER_NOT_FOUND_CODE,
  LOCAL_REQUEST_INVALID_CODE,
  LOCAL_SERVER_NOT_FOUND_ADVICE,
  LOCAL_SERVER_NOT_FOUND_CODE,
  LOCAL_SERVER_NOT_FOUND_MESSAGE,
  LOCAL_SERVER_RECHECK_HINT,
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
  error: { code: 400, message: "tools param requires --jinja flag", type: "invalid_request_error" },
});

/** A llama-server HTTP error the way `buildHttpError` makes one. */
function llamaHttp(status: number, url: string, rawBody = ""): LlamaServerError {
  const body = readLlamaErrorBody(rawBody);
  return new LlamaServerError(
    `llama-server returned http ${status}`,
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
