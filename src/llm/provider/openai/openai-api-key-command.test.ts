import { describe, expect, it, vi } from "vitest";

import { createApiKeyCommandSource, type RunKeyCommand } from "./api-key-command.js";
import { OpenAiProvider } from "./openai-provider.js";

/**
 * A key printed by a command (Vertex AI's `gcloud auth print-access-token`)
 * on the request path: sent as Bearer, re-run once on a 401, and never
 * written anywhere the operator's logs could carry it.
 */

const ROOT =
  "https://us-central1-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-central1/endpoints/openapi";

function okBody(): Response {
  return new Response(
    JSON.stringify({
      model: "google/gemini-2.5-flash",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: { code: 401, message: "Request had invalid authentication credentials." } }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

function tokens(...values: string[]): RunKeyCommand & { runs: () => number } {
  let n = 0;
  const run = (async () => values[Math.min(n++, values.length - 1)]!) as RunKeyCommand & {
    runs: () => number;
  };
  run.runs = () => n;
  return run;
}

function spyLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function provider(fetchImpl: typeof fetch, run: RunKeyCommand, logger = spyLogger()) {
  return new OpenAiProvider({
    id: "google-vertex",
    providerKind: "openai-compatible",
    baseUrl: ROOT,
    apiKey: "",
    defaultChatModel: "google/gemini-2.5-flash",
    apiKeySource: createApiKeyCommandSource(["gcloud", "auth", "print-access-token"], {
      label: "google-vertex",
      run,
    }),
    fetchImpl,
    logger: logger as never,
  });
}

const authOf = (fetchImpl: ReturnType<typeof vi.fn>, i: number): string | null =>
  new Headers((fetchImpl.mock.calls[i]?.[1] as RequestInit).headers as HeadersInit).get(
    "authorization",
  );

describe("apiKeyCommand on the request path", () => {
  it("sends the command output as Bearer to Vertex's chat route", async () => {
    const fetchImpl = vi.fn(async () => okBody());
    const run = tokens("ya29.first-token");

    await provider(fetchImpl as unknown as typeof fetch, run).complete({ prompt: "hi" });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${ROOT}/chat/completions`);
    expect(authOf(fetchImpl, 0)).toBe("Bearer ya29.first-token");
  });

  it("re-runs the command on a 401 and resends with the new token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(okBody());
    const run = tokens("ya29.expired-token", "ya29.fresh-token");

    const result = await provider(fetchImpl as unknown as typeof fetch, run).complete({
      prompt: "hi",
    });

    expect(result.content).toBe("ok");
    expect(run.runs()).toBe(2);
    expect(authOf(fetchImpl, 0)).toBe("Bearer ya29.expired-token");
    expect(authOf(fetchImpl, 1)).toBe("Bearer ya29.fresh-token");
  });

  it("resends only once: a second 401 is the real answer", async () => {
    const fetchImpl = vi.fn(async () => unauthorized());
    const run = tokens("ya29.bad-token-one", "ya29.bad-token-two");

    await expect(
      provider(fetchImpl as unknown as typeof fetch, run).complete({ prompt: "hi" }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(run.runs()).toBe(2);
  });

  it("reuses the cached token across turns instead of running the command each time", async () => {
    const fetchImpl = vi.fn(async () => okBody());
    const run = tokens("ya29.cached-token");
    const p = provider(fetchImpl as unknown as typeof fetch, run);

    await p.complete({ prompt: "one" });
    await p.complete({ prompt: "two" });

    expect(run.runs()).toBe(1);
  });

  it("turns a failing command into a 401 without sending anything", async () => {
    const fetchImpl = vi.fn(async () => okBody());
    const run: RunKeyCommand = async () => {
      throw Object.assign(new Error("gcloud crashed"), { code: 1 });
    };

    await expect(
      provider(fetchImpl as unknown as typeof fetch, run).complete({ prompt: "hi" }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never logs the command output or puts it in an error", async () => {
    const secret = "ya29.must-never-be-logged";
    const logger = spyLogger();
    const fetchImpl = vi.fn(async () => unauthorized());

    const error = await provider(
      fetchImpl as unknown as typeof fetch,
      tokens(secret),
      logger,
    )
      .complete({ prompt: "hi" })
      .catch((err: unknown) => err as Error);

    const logged = JSON.stringify([
      logger.debug.mock.calls,
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls,
    ]);
    expect(logged).not.toContain(secret);
    expect(String(error?.message)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});
