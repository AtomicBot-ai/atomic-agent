import { describe, expect, it, vi } from "vitest";

import {
  OpenAiHttpError,
  openAiPostJson,
  openAiStartStream,
  createOpenAiAttemptBudget,
  type OpenAiHttpDeps,
} from "./openai-http.js";
import { createKeyPool, createKeyPoolStore } from "../../fallback/key-pool.js";

/** ATO-471: a refused key is swapped for the next key of the same provider. */

function deps(fetchImpl: typeof fetch, keys: string[] | null): OpenAiHttpDeps {
  const keyPool = keys
    ? createKeyPool({ providerId: "p", keys, store: createKeyPoolStore() })
    : undefined;
  return {
    baseUrl: "https://api.example.com",
    apiKey: keys?.[0] ?? "k1",
    extraHeaders: {},
    requestTimeoutMs: 60_000,
    fetchImpl,
    label: "p",
    ...(keyPool ? { keyPool } : {}),
  };
}

/** Answers by the bearer key the request carried. */
function fetchByKey(answers: Record<string, () => Response>) {
  const seen: string[] = [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>).authorization ?? "";
    const key = auth.replace(/^Bearer /, "");
    seen.push(key);
    const answer = answers[key];
    if (!answer) throw new Error(`unexpected key ${key}`);
    return answer();
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, seen };
}

const ok = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const status = (code: number, body = "boom") => () => new Response(body, { status: code });
const stream = () =>
  new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

describe("openAiPostJson with a key pool", () => {
  it("tries the next key on a 429, without retrying the limited key in place", async () => {
    const { fetchImpl, seen } = fetchByKey({ k1: status(429), k2: ok });
    const result = await openAiPostJson(deps(fetchImpl, ["k1", "k2"]), "/v1/chat/completions", {}, {});
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual(["k1", "k2"]);
  });

  it("tries the next key on a refused key and on an empty account", async () => {
    const { fetchImpl, seen } = fetchByKey({ k1: status(401), k2: status(402), k3: ok });
    await openAiPostJson(deps(fetchImpl, ["k1", "k2", "k3"]), "/v1/chat/completions", {}, {});
    expect(seen).toEqual(["k1", "k2", "k3"]);
  });

  it("stays on the key that served for the next request", async () => {
    const { fetchImpl, seen } = fetchByKey({ k1: status(429), k2: ok });
    const d = deps(fetchImpl, ["k1", "k2"]);
    await openAiPostJson(d, "/v1/chat/completions", {}, {});
    await openAiPostJson(d, "/v1/chat/completions", {}, {});
    expect(seen).toEqual(["k1", "k2", "k2"]);
  });

  it("throws the last refusal once every key was refused, for the chain to handle", async () => {
    const { fetchImpl, seen } = fetchByKey({ k1: status(401), k2: status(401) });
    const err = await openAiPostJson(deps(fetchImpl, ["k1", "k2"]), "/v1/chat/completions", {}, {}).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OpenAiHttpError);
    expect((err as OpenAiHttpError).status).toBe(401);
    expect(seen).toEqual(["k1", "k2"]);
  });

  it("does not switch keys on a bad request", async () => {
    const { fetchImpl, seen } = fetchByKey({ k1: status(400), k2: ok });
    await expect(
      openAiPostJson(deps(fetchImpl, ["k1", "k2"]), "/v1/chat/completions", {}, {}),
    ).rejects.toBeInstanceOf(OpenAiHttpError);
    expect(seen).toEqual(["k1"]);
  });

  it("keeps the single-key path unchanged: a 429 is retried in place", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => (++calls === 1 ? status(429)() : ok()));
    await openAiPostJson(deps(fetchImpl as unknown as typeof fetch, null), "/v1/chat/completions", {}, {});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("openAiStartStream with a key pool", () => {
  it("opens the stream on the next key after a 429", async () => {
    const { fetchImpl, seen } = fetchByKey({ k1: status(429), k2: stream });
    const res = await openAiStartStream(
      deps(fetchImpl, ["k1", "k2"]),
      "/v1/chat/completions",
      {},
      {},
      createOpenAiAttemptBudget(),
    );
    expect(res.ok).toBe(true);
    expect(seen).toEqual(["k1", "k2"]);
  });

  it("stops rotating once the completion's attempt budget is spent", async () => {
    const { fetchImpl, seen } = fetchByKey({
      k1: status(401),
      k2: status(401),
      k3: status(401),
      k4: stream,
    });
    await expect(
      openAiStartStream(
        deps(fetchImpl, ["k1", "k2", "k3", "k4"]),
        "/v1/chat/completions",
        {},
        {},
        createOpenAiAttemptBudget(),
      ),
    ).rejects.toBeInstanceOf(OpenAiHttpError);
    expect(seen).toEqual(["k1", "k2", "k3"]);
  });
});
