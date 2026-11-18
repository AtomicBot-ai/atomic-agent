import { describe, expect, it, vi } from "vitest";

import {
  COPILOT_API_BASE_URL,
  COPILOT_DEFAULT_MODEL,
  COPILOT_GITHUB_CLIENT_ID,
  COPILOT_TOKEN_URL,
  CopilotNotAvailableError,
  CopilotSignInRequiredError,
  completeCopilotDeviceLogin,
  createCopilotTokenSource,
  githubDeviceFetch,
  parseCopilotToken,
  requestCopilotDeviceCode,
  type CopilotGetFetch,
} from "./github-copilot.js";
import { createSubscriptionOAuthProvider } from "./create-subscription-oauth-provider.js";
import { OAuthFlowError } from "./oauth-errors.js";
import type { FetchLike, OAuthTokens, TokenStore } from "./oauth-types.js";

const GH_TOKEN = "gho_secret_github_token_123";
const COPILOT_TOKEN = "tid=secret_copilot_token;exp=1";

function memoryStore(tokens: OAuthTokens | null): TokenStore {
  let held = tokens;
  return {
    load: async () => held,
    save: async (t) => {
      held = t;
    },
    clear: async () => {
      held = null;
    },
  };
}

const reply = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

describe("githubDeviceFetch (GitHub answers a pending grant with 200 + error)", () => {
  it("turns a 200 error body into a 400 and leaves tokens alone", async () => {
    const pending = githubDeviceFetch(async () => reply(200, { error: "authorization_pending" }));
    const res = await pending("u", { method: "POST", headers: {}, body: "" });
    expect(res.status).toBe(400);
    expect(res.ok).toBe(false);
    expect(JSON.parse(await res.text())).toEqual({ error: "authorization_pending" });

    const tokens = githubDeviceFetch(async () => reply(200, { access_token: GH_TOKEN, token_type: "bearer" }));
    const ok = await tokens("u", { method: "POST", headers: {}, body: "" });
    expect(ok.status).toBe(200);
    expect(ok.ok).toBe(true);
  });
});

describe("Copilot device sign-in", () => {
  it("asks github.com with the Copilot app id and polls through pending and slow_down", async () => {
    const calls: { url: string; body: string }[] = [];
    const answers = [
      reply(200, {
        device_code: "dc_secret",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
      reply(200, { error: "authorization_pending" }),
      reply(200, { error: "slow_down" }),
      reply(200, { access_token: GH_TOKEN, token_type: "bearer", scope: "read:user" }),
    ];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, body: init.body });
      return answers.shift()!;
    };
    const sleep = vi.fn(async () => {});
    const options = { fetch, sleep, now: () => 0 };
    const code = await requestCopilotDeviceCode(options);
    expect(code.userCode).toBe("ABCD-1234");
    expect(calls[0]!.url).toBe("https://github.com/login/device/code");
    expect(new URLSearchParams(calls[0]!.body).get("client_id")).toBe(COPILOT_GITHUB_CLIENT_ID);
    expect(new URLSearchParams(calls[0]!.body).get("scope")).toBe("read:user");

    const tokens = await completeCopilotDeviceLogin(options, code);
    expect(tokens.accessToken).toBe(GH_TOKEN);
    expect(calls.slice(1).every((c) => c.url === "https://github.com/login/oauth/access_token")).toBe(true);
    // 5 s, 5 s, then 10 s after slow_down.
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([5000, 5000, 10000]);
  });

  it("a denied grant is authorization_denied, with no device code in the error", async () => {
    const fetch: FetchLike = async () => reply(200, { error: "access_denied" });
    const err = await completeCopilotDeviceLogin(
      { fetch, sleep: async () => {}, now: () => 0 },
      { deviceCode: "dc_secret", userCode: "X", verificationUri: "v", expiresAt: 900_000, intervalMs: 5000 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthFlowError);
    expect((err as OAuthFlowError).code).toBe("authorization_denied");
    expect(String((err as Error).message)).not.toContain("dc_secret");
  });
});

describe("parseCopilotToken", () => {
  it("reads expires_at in seconds, falls back to refresh_in, refuses a missing token", () => {
    expect(parseCopilotToken({ token: "t", expires_at: 2_000 }, 0)).toEqual({ token: "t", expiresAt: 2_000_000 });
    expect(parseCopilotToken({ token: "t", refresh_in: 1500 }, 1_000)).toEqual({ token: "t", expiresAt: 1_501_000 });
    expect(parseCopilotToken({ expires_at: 2_000 }, 0)).toBeNull();
    expect(parseCopilotToken("nope", 0)).toBeNull();
  });
});

describe("createCopilotTokenSource", () => {
  const signedIn = (): TokenStore => memoryStore({ accessToken: GH_TOKEN });

  it("exchanges the GitHub token once, caches until shortly before expiry, then exchanges again", async () => {
    let clock = 1_000_000;
    const fetch = vi.fn<CopilotGetFetch>(async () =>
      reply(200, { token: COPILOT_TOKEN, expires_at: Math.floor(clock / 1000) + 1800 }),
    );
    const source = createCopilotTokenSource({ store: signedIn(), fetch, now: () => clock });
    const [a, b] = await Promise.all([source.get(), source.get()]);
    expect(a).toBe(COPILOT_TOKEN);
    expect(b).toBe(COPILOT_TOKEN);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(COPILOT_TOKEN_URL);
    expect(init.headers.authorization).toBe(`token ${GH_TOKEN}`);
    expect(init.headers["copilot-integration-id"]).toBe("vscode-chat");

    clock += 10 * 60_000;
    await source.get();
    expect(fetch).toHaveBeenCalledTimes(1);
    clock += 20 * 60_000; // past expiry minus the minute of skew
    await source.get();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("invalidate() forces a new exchange (the provider calls it after a 401)", async () => {
    const fetch = vi.fn<CopilotGetFetch>(async () => reply(200, { token: COPILOT_TOKEN, expires_at: 9_999_999_999 }));
    const source = createCopilotTokenSource({ store: signedIn(), fetch, now: () => 0 });
    await source.get();
    source.invalidate();
    await source.get();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("no stored sign-in, or GitHub refusing it, says to run atag login copilot", async () => {
    const fetch = vi.fn<CopilotGetFetch>(async () => reply(401, { message: `bad ${GH_TOKEN}` }));
    const none = createCopilotTokenSource({ store: memoryStore(null), fetch });
    await expect(none.get()).rejects.toBeInstanceOf(CopilotSignInRequiredError);
    expect(fetch).not.toHaveBeenCalled();

    const refused = createCopilotTokenSource({ store: signedIn(), fetch });
    const err = await refused.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CopilotSignInRequiredError);
    expect((err as Error).message).toContain("atag login copilot");
    expect((err as Error).message).not.toContain(GH_TOKEN);
  });

  it("an account without Copilot gets its own sentence; other failures carry no server text or token", async () => {
    const noPlan = createCopilotTokenSource({
      store: signedIn(),
      fetch: async () => reply(403, { message: "no copilot" }),
    });
    await expect(noPlan.get()).rejects.toBeInstanceOf(CopilotNotAvailableError);

    const down = createCopilotTokenSource({
      store: signedIn(),
      fetch: async () => {
        throw new Error(`connect failed with ${GH_TOKEN}`);
      },
    });
    const err = await down.get().catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/Cannot reach api\.github\.com/);
    expect((err as Error).message).not.toContain(GH_TOKEN);

    const broken = createCopilotTokenSource({ store: signedIn(), fetch: async () => reply(500, "oops") });
    const err500 = await broken.get().catch((e: unknown) => e);
    expect((err500 as Error).message).toContain("HTTP 500");
    expect((err500 as Error).message).not.toContain("oops");
  });

  it("a failed exchange is retried on the next call, not cached", async () => {
    const answers = [reply(500, ""), reply(200, { token: COPILOT_TOKEN, expires_at: 9_999_999_999 })];
    const source = createCopilotTokenSource({ store: signedIn(), fetch: async () => answers.shift()!, now: () => 0 });
    await expect(source.get()).rejects.toThrow();
    await expect(source.get()).resolves.toBe(COPILOT_TOKEN);
  });
});

describe("createSubscriptionOAuthProvider for service copilot", () => {
  it("sends chat to api.githubcopilot.com/chat/completions with the Copilot token and editor headers", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createFileTokenStore, subscriptionTokenPath } = await import("./credential-store.js");
    const dir = mkdtempSync(join(tmpdir(), "copilot-provider-"));
    try {
      await createFileTokenStore({ path: subscriptionTokenPath(dir, "copilot") }).save({ accessToken: GH_TOKEN });
      const seen: { url: string; headers: Headers }[] = [];
      const chatFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(input), headers: new Headers(init?.headers) });
        return new Response(
          JSON.stringify({
            id: "c1",
            model: COPILOT_DEFAULT_MODEL,
            choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;
      const provider = createSubscriptionOAuthProvider({
        entry: {
          id: "copilot-sub",
          kind: "subscription-oauth",
          subscriptionOauth: { service: "copilot" },
          // Ignored on purpose: the Copilot token only goes to GitHub's host.
          baseUrl: "https://attacker.example",
        } as never,
        stateDir: dir,
        copilotTokenFetch: async () => reply(200, { token: COPILOT_TOKEN, expires_at: 9_999_999_999 }),
        copilotChatFetch: chatFetch,
      });
      expect(provider.id).toBe("copilot-sub");
      await provider
        .complete({ prompt: "hello" })
        .catch(() => undefined);
      const chat = seen.find((s) => s.url.endsWith("/chat/completions"));
      expect(chat?.url).toBe(`${COPILOT_API_BASE_URL}/chat/completions`);
      expect(chat?.headers.get("authorization")).toBe(`Bearer ${COPILOT_TOKEN}`);
      expect(chat?.headers.get("copilot-integration-id")).toBe("vscode-chat");
      expect(chat?.headers.get("editor-version")).toMatch(/^vscode\//);
      expect(seen.every((s) => !s.url.includes("attacker.example"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still refuses a service it does not know", () => {
    expect(() =>
      createSubscriptionOAuthProvider({
        entry: { id: "x", kind: "subscription-oauth", subscriptionOauth: { service: "grok" } } as never,
        stateDir: "/nonexistent",
      }),
    ).toThrow(/unknown service "grok"/);
  });
});
