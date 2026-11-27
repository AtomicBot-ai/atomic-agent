import { describe, expect, it } from "vitest";
import { LlamaServerClient, LlamaServerError, keyRefusedError } from "./llama-server-client.js";
import type { OwnEngineState } from "./llama-own-engine-state.js";

/**
 * ATO-1732: a 401 on the managed chat port while our own model process is
 * not there comes from another program. The words say so; the error stays
 * a 401 `LlamaServerError` so Sentry grouping and hosts read it as before.
 */
function refusingClient(ownEngine: OwnEngineState, asked: string[] = []): LlamaServerClient {
  return new LlamaServerClient({
    baseUrl: "http://127.0.0.1:9931",
    apiKey: "our-key",
    completionRetries: 1,
    progressWatch: false,
    refreshApiKey: async () => null,
    ownEngineState: (url) => { asked.push(url); return ownEngine; },
    fetchImpl: (async () =>
      new Response(JSON.stringify({ error: { code: 401, message: "Invalid API Key" } }), { status: 401 })) as typeof fetch,
  });
}

async function refusal(client: LlamaServerClient): Promise<LlamaServerError> {
  const err = await client.complete({ prompt: "p" }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(LlamaServerError);
  return err as LlamaServerError;
}

describe("LlamaServerClient on a 401 with our engine gone (ATO-1732)", () => {
  it("says another program answers, still as a 401", async () => {
    const asked: string[] = [];
    const err = await refusal(refusingClient("gone", asked));
    expect(err.status).toBe(401);
    expect(err.message).toContain("Another program answers on the local model's address");
    expect(err.message).toContain("localModels.managed.port");
    expect(err.message).not.toContain("atomic-agent models start");
    expect(asked).toEqual(["http://127.0.0.1:9931/completion"]);
  });

  it("does the same for the stream's opening request", async () => {
    const stream = refusingClient("gone").completeStream({ prompt: "p" });
    const err = await stream.next().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlamaServerError);
    expect((err as LlamaServerError).status).toBe(401);
    expect((err as LlamaServerError).message).toContain("Another program answers");
  });

  it("keeps the restart advice while our process is alive", async () => {
    const err = await refusal(refusingClient("running"));
    expect(err.status).toBe(401);
    expect(err.message).toContain("refused the agent's key");
    expect(err.message).toContain("atomic-agent models start");
    expect(err.message).not.toContain("Another program");
  });

  it("keeps the restart advice when the engine state is unknown", async () => {
    const err = await refusal(refusingClient("unknown"));
    expect(err.message).toContain("atomic-agent models start");
    expect(err.message).not.toContain("Another program");
  });
});

describe("keyRefusedError with our engine gone (ATO-1732)", () => {
  const refused = new LlamaServerError("llama-server returned http 401: Invalid API Key", 401, "http://127.0.0.1:9931/completion");

  it("keeps the server's words, the status and the cause", () => {
    for (const keySent of [true, false]) {
      const err = keyRefusedError(refused, keySent, "gone");
      expect(err).toBeInstanceOf(LlamaServerError);
      expect(err.status).toBe(401);
      expect(err.url).toBe(refused.url);
      expect(err.message.startsWith("llama-server returned http 401: Invalid API Key.")).toBe(true);
      expect(err.message).toContain("Another program answers");
      expect((err as Error & { cause?: unknown }).cause).toBe(refused);
    }
  });
});
