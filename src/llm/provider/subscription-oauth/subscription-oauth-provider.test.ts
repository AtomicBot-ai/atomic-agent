import { describe, expect, it, vi } from "vitest";

import { isCredentialRejection, isOutageFailure } from "../../fallback/link-failure-kind.js";
import { OpenAiHttpError } from "../openai/openai-http.js";
import { isSubscriptionCliSetupError } from "../subscription-cli/subscription-cli-errors.js";
import { ChatgptSignInRequiredError, SignInRequiredError, OAuthFlowError } from "./oauth-errors.js";
import type { OAuthTokens, TokenStore } from "./oauth-types.js";
import type { TokenRefresher } from "./token-refresh.js";
import {
  CHATGPT_DEFAULT_MODEL,
  SubscriptionOAuthProvider,
  type ResponsesFetch,
} from "./subscription-oauth-provider.js";

const jwt = (payload: Record<string, unknown>): string =>
  [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");

const tokensFor = (access: string): OAuthTokens => ({
  accessToken: access,
  refreshToken: "rt",
  idToken: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-9" } }),
});

function sse(...events: unknown[]): ReadableStream<Uint8Array> {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

type Res = Awaited<ReturnType<ResponsesFetch>>;
const ok = (body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Res => ({
  status: 200,
  ok: true,
  headers: new Headers(headers),
  body,
  text: async () => "",
});
const fail = (status: number, text = ""): Res => ({
  status,
  ok: false,
  headers: new Headers(),
  body: null,
  text: async () => text,
});

const COMPLETED = {
  type: "response.completed",
  response: { id: "resp_1", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } },
};

function setup(responses: Res[], refresher?: Partial<TokenRefresher>) {
  let current: OAuthTokens | null = tokensFor("access-1");
  const store: TokenStore = {
    load: async () => current,
    save: async (t) => {
      current = t;
    },
    clear: async () => {
      current = null;
    },
  };
  const fetchImpl = vi.fn<ResponsesFetch>();
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r);
  const refresh = vi.fn(async () => tokensFor("access-2"));
  const provider = new SubscriptionOAuthProvider({
    id: "chatgpt-sub",
    store,
    refresher: {
      getValidTokens: async () => tokensFor("access-1"),
      refresh,
      ...refresher,
    },
    fetch: fetchImpl,
  });
  return { provider, fetchImpl, refresh, store };
}

describe("SubscriptionOAuthProvider", () => {
  it("is native-tools, keyless and experimental by name", () => {
    const { provider } = setup([]);
    expect(provider.capabilities.toolTransport).toBe("native_tools");
    expect(provider.name).toMatch(/experimental/i);
    expect(provider.chatModelId).toBe(CHATGPT_DEFAULT_MODEL);
  });

  it("answers a plain prompt and signs the request like Codex", async () => {
    const { provider, fetchImpl } = setup([
      ok(
        sse(
          { type: "response.created", response: { id: "resp_1" } },
          { type: "response.output_text.delta", delta: "Hel" },
          { type: "response.output_text.delta", delta: "lo" },
          COMPLETED,
        ),
        { "x-codex-primary-used-percent": "12", "x-codex-primary-window-minutes": "300" },
      ),
    ]);
    const result = await provider.complete({ prompt: "hi", sessionId: "s-1" });
    expect(result.content).toBe("Hello");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    expect(result.generationId).toBe("resp_1");
    expect(result.rateLimits?.[0]).toMatchObject({ scope: "subscription", usedPercent: 12 });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(init.headers.authorization).toBe("Bearer access-1");
    expect(init.headers["chatgpt-account-id"]).toBe("acct-9");
    expect(init.headers.originator).toBe("atomic_agent");
    expect(init.headers["session-id"]).toBe("s-1");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: CHATGPT_DEFAULT_MODEL, store: false, stream: true });
  });

  it("streams deltas, then returns tool calls", async () => {
    const { provider } = setup([
      ok(
        sse(
          { type: "response.reasoning_summary_text.delta", delta: "plan", summary_index: 0 },
          {
            type: "response.output_item.done",
            item: { type: "function_call", call_id: "call_1", name: "os__fs__read", arguments: '{"path":"a"}' },
          },
          COMPLETED,
        ),
      ),
    ]);
    const stream = provider.completeStream({ prompt: "read a" });
    const chunks = [];
    let next = await stream.next();
    while (!next.done) {
      chunks.push(next.value);
      next = await stream.next();
    }
    expect(chunks[0]).toEqual({ delta: "", reasoningDelta: "plan", done: false });
    expect(chunks.at(-1)?.done).toBe(true);
    expect(next.value.reasoningContent).toBe("plan");
    expect(next.value.finishReason).toBe("tool_calls");
    expect(next.value.toolCalls).toEqual([
      { id: "call_1", type: "function", function: { name: "os__fs__read", arguments: '{"path":"a"}' } },
    ]);
  });

  it("uses a whole message item when no deltas came", async () => {
    const { provider } = setup([
      ok(
        sse(
          { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "whole" }] } },
          COMPLETED,
        ),
      ),
    ]);
    await expect(provider.complete({ prompt: "x" })).resolves.toMatchObject({ content: "whole" });
  });

  it("refreshes once on a 401 and retries with the new token", async () => {
    const { provider, fetchImpl, refresh } = setup([
      fail(401),
      ok(sse({ type: "response.output_text.delta", delta: "ok" }, COMPLETED)),
    ]);
    await expect(provider.complete({ prompt: "x" })).resolves.toMatchObject({ content: "ok" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[1]![1].headers.authorization).toBe("Bearer access-2");
  });

  it("a second 401 asks for a new sign-in instead of looping", async () => {
    const { provider, fetchImpl, refresh } = setup([fail(401), fail(401), fail(401)]);
    const err = await provider.complete({ prompt: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatgptSignInRequiredError);
    expect((err as Error).message).toMatch(/atag login chatgpt/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    // A setup refusal: the turn says what to do, it does not wait it out.
    expect(isSubscriptionCliSetupError(err)).toBe(true);
    expect(isOutageFailure(err)).toBe(false);
  });

  it("a refused refresh token asks for a new sign-in and keeps the stored tokens, as Codex does", async () => {
    const { provider, store } = setup([fail(401)], {
      refresh: async () => {
        throw new SignInRequiredError("refresh_refused");
      },
    });
    const err = await provider.complete({ prompt: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatgptSignInRequiredError);
    expect((err as Error).message).toMatch(/^Sign in again/);
    // Nadya 18.11: nothing is deleted; the next `atag login chatgpt` overwrites the file.
    await expect(store.load()).resolves.not.toBeNull();
  });

  it("a 401 from the token endpoint asks for a new sign-in, as in Codex", async () => {
    const { provider } = setup([fail(401)], {
      refresh: async () => {
        throw new OAuthFlowError("token_request_failed", { status: 401, oauthError: "unknown" });
      },
    });
    await expect(provider.complete({ prompt: "x" })).rejects.toBeInstanceOf(ChatgptSignInRequiredError);
  });

  it("no stored sign-in fails before anything is sent", async () => {
    const { provider, fetchImpl } = setup([], {
      getValidTokens: async () => {
        throw new SignInRequiredError("no_tokens");
      },
    });
    await expect(provider.complete({ prompt: "x" })).rejects.toBeInstanceOf(ChatgptSignInRequiredError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("types other HTTP failures for the fallback chain", async () => {
    const { provider } = setup([fail(429, JSON.stringify({ detail: "usage limit reached" }))]);
    const err = await provider.complete({ prompt: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAiHttpError);
    expect((err as OpenAiHttpError).status).toBe(429);
    expect((err as Error).message).toContain("usage limit reached");
    expect(isCredentialRejection(err)).toBe(false);
  });

  it("a stream that ends without response.completed is an error, not a short reply", async () => {
    const { provider } = setup([ok(sse({ type: "response.output_text.delta", delta: "half" }))]);
    await expect(provider.complete({ prompt: "x" })).rejects.toBeInstanceOf(OpenAiHttpError);
  });

  it("an error inside the stream is typed with the backend's words", async () => {
    const { provider } = setup([
      ok(sse({ type: "response.failed", response: { error: { code: "server_error", message: "boom" } } })),
    ]);
    await expect(provider.complete({ prompt: "x" })).rejects.toMatchObject({ streamError: "boom" });
  });

  it("health reads the token file and sends nothing", async () => {
    const { provider, fetchImpl, store } = setup([]);
    await expect(provider.health()).resolves.toMatchObject({ reachable: true });
    await store.clear();
    await expect(provider.health()).resolves.toMatchObject({ reachable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
