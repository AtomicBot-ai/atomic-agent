import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

import {
  CHATGPT_CLIENT_ID,
  CHATGPT_DEVICE_REDIRECT_URI,
  CHATGPT_DEVICE_TOKEN_URL,
  CHATGPT_DEVICE_USERCODE_URL,
  CHATGPT_TOKEN_URL,
  ChatgptNoAccountError,
  chatgptAccountId,
  chatgptPlanType,
  completeChatgptDeviceLogin,
  createChatgptTokenRefresher,
  requestChatgptDeviceCode,
  startChatgptBrowserLogin,
  withJwtExpiry,
  type JsonFetchLike,
} from "./chatgpt-codex.js";
import { OAuthFlowError, SignInRequiredError } from "./oauth-errors.js";
import type { FetchLike, OAuthTokens, TokenStore } from "./oauth-types.js";

const jwt = (payload: Record<string, unknown>): string =>
  [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");

const AUTH = "https://api.openai.com/auth";
const ID_TOKEN = jwt({ [AUTH]: { chatgpt_account_id: "acct-42", chatgpt_plan_type: "plus" } });
const ACCESS_TOKEN = jwt({ exp: 1_900_000_000 });

const response = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (body === undefined ? "" : JSON.stringify(body)),
});

describe("chatgptAccountId", () => {
  it("reads chatgpt_account_id from the id token", () => {
    expect(chatgptAccountId({ idToken: ID_TOKEN, accessToken: "x" })).toBe("acct-42");
    expect(chatgptPlanType({ idToken: ID_TOKEN, accessToken: "x" })).toBe("plus");
  });

  it("falls back to the access token", () => {
    const access = jwt({ [AUTH]: { chatgpt_account_id: "acct-7" } });
    expect(chatgptAccountId({ accessToken: access })).toBe("acct-7");
  });

  it("is null for an opaque or claimless token", () => {
    expect(chatgptAccountId({ accessToken: "opaque" })).toBeNull();
    expect(chatgptAccountId({ accessToken: jwt({ sub: "u" }) })).toBeNull();
  });
});

describe("withJwtExpiry", () => {
  it("takes the access token's exp when the server sent no expires_in", () => {
    expect(withJwtExpiry({ accessToken: ACCESS_TOKEN }).expiresAt).toBe(1_900_000_000_000);
  });

  it("keeps an expiry the server sent", () => {
    expect(withJwtExpiry({ accessToken: ACCESS_TOKEN, expiresAt: 5 }).expiresAt).toBe(5);
  });
});

describe("startChatgptBrowserLogin", () => {
  it("builds the Codex authorize URL and exchanges the code", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      response(200, { access_token: ACCESS_TOKEN, refresh_token: "rt", id_token: ID_TOKEN }),
    );
    const login = await startChatgptBrowserLogin({ fetch: fetchImpl, timeoutMs: 5_000, ports: [0] });
    const url = new URL(login.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(CHATGPT_CLIENT_ID);
    expect(url.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
    expect(url.searchParams.get("originator")).toBe("atomic_agent");
    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    expect(redirect.hostname).toBe("localhost");
    expect(redirect.pathname).toBe("/auth/callback");

    const state = url.searchParams.get("state") ?? "";
    const hit = await fetch(`http://127.0.0.1:${redirect.port}/auth/callback?code=c1&state=${state}`);
    expect(hit.status).toBe(200);
    const tokens = await login.tokens;
    expect(tokens.idToken).toBe(ID_TOKEN);
    expect(tokens.expiresAt).toBe(1_900_000_000_000);
    const [tokenUrl, init] = fetchImpl.mock.calls[0]!;
    expect(tokenUrl).toBe(CHATGPT_TOKEN_URL);
    const form = new URLSearchParams(init.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("redirect_uri")).toBe(redirect.toString());
  });

  it("moves to the next port when the first is taken", async () => {
    const busy = createServer();
    await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
    const busyPort = (busy.address() as AddressInfo).port;
    try {
      const login = await startChatgptBrowserLogin({
        fetch: vi.fn<FetchLike>(),
        timeoutMs: 5_000,
        ports: [busyPort, 0],
      });
      const redirect = new URL(new URL(login.authorizationUrl).searchParams.get("redirect_uri") ?? "");
      expect(Number(redirect.port)).not.toBe(busyPort);
      login.cancel();
      await expect(login.tokens).rejects.toBeInstanceOf(OAuthFlowError);
    } finally {
      busy.close();
    }
  });

  it("refuses a sign-in whose token names no ChatGPT account", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => response(200, { access_token: "opaque", id_token: jwt({}) }));
    const login = await startChatgptBrowserLogin({ fetch: fetchImpl, timeoutMs: 5_000, ports: [0] });
    const url = new URL(login.authorizationUrl);
    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    // Listen before the callback: the refusal can land while the fetch
    // below is still in flight, and an unheard rejection fails the run.
    const refused = expect(login.tokens).rejects.toBeInstanceOf(ChatgptNoAccountError);
    await fetch(`http://127.0.0.1:${redirect.port}/auth/callback?code=c&state=${url.searchParams.get("state")}`);
    await refused;
  });
});

describe("device code sign-in", () => {
  it("requests a user code with the Codex client id", async () => {
    const fetchImpl = vi.fn<JsonFetchLike>(async () =>
      response(200, { device_auth_id: "dev-1", user_code: "ABCD-EFGH", interval: "7" }),
    );
    const code = await requestChatgptDeviceCode({ fetch: fetchImpl });
    expect(code).toEqual({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      deviceAuthId: "dev-1",
      intervalMs: 7_000,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(CHATGPT_DEVICE_USERCODE_URL);
    expect(JSON.parse(init.body)).toEqual({ client_id: CHATGPT_CLIENT_ID });
  });

  it("says when device sign-in is not enabled", async () => {
    const fetchImpl = vi.fn<JsonFetchLike>(async () => response(404, undefined));
    await expect(requestChatgptDeviceCode({ fetch: fetchImpl })).rejects.toMatchObject({
      code: "token_request_failed",
      oauthError: "device_login_not_enabled",
    });
  });

  it("polls through 403s, then exchanges the code with the returned verifier", async () => {
    const poll = vi
      .fn<JsonFetchLike>()
      .mockResolvedValueOnce(response(403, undefined))
      .mockResolvedValueOnce(response(404, undefined))
      .mockResolvedValueOnce(response(200, { authorization_code: "auth-code", code_verifier: "verifier", code_challenge: "ch" }));
    const formFetch = vi.fn<FetchLike>(async () =>
      response(200, { access_token: ACCESS_TOKEN, refresh_token: "rt", id_token: ID_TOKEN }),
    );
    const sleep = vi.fn(async () => undefined);
    const tokens = await completeChatgptDeviceLogin(
      { fetch: poll, formFetch, sleep, now: () => 0 },
      { verificationUrl: "v", userCode: "U", deviceAuthId: "D", intervalMs: 1_000 },
    );
    expect(tokens.refreshToken).toBe("rt");
    expect(poll).toHaveBeenCalledTimes(3);
    expect(poll.mock.calls[0]![0]).toBe(CHATGPT_DEVICE_TOKEN_URL);
    expect(JSON.parse(poll.mock.calls[0]![1].body)).toEqual({ device_auth_id: "D", user_code: "U" });
    expect(sleep).toHaveBeenCalledTimes(2);
    const form = new URLSearchParams(formFetch.mock.calls[0]![1].body);
    expect(form.get("code")).toBe("auth-code");
    expect(form.get("code_verifier")).toBe("verifier");
    expect(form.get("redirect_uri")).toBe(CHATGPT_DEVICE_REDIRECT_URI);
  });

  it("gives up after 15 minutes", async () => {
    let clock = 0;
    const poll = vi.fn<JsonFetchLike>(async () => response(403, undefined));
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    await expect(
      completeChatgptDeviceLogin(
        { fetch: poll, formFetch: vi.fn<FetchLike>(), sleep, now: () => clock },
        { verificationUrl: "v", userCode: "U", deviceAuthId: "D", intervalMs: 60_000 },
      ),
    ).rejects.toMatchObject({ code: "device_code_expired" });
  });

  it("stops on any other status", async () => {
    const poll = vi.fn<JsonFetchLike>(async () => response(500, { error: "server_error" }));
    await expect(
      completeChatgptDeviceLogin(
        { fetch: poll, formFetch: vi.fn<FetchLike>(), sleep: async () => undefined },
        { verificationUrl: "v", userCode: "U", deviceAuthId: "D", intervalMs: 1 },
      ),
    ).rejects.toMatchObject({ code: "token_request_failed", status: 500 });
  });
});

describe("createChatgptTokenRefresher", () => {
  const memory = (initial: OAuthTokens | null) => {
    const store: TokenStore & { current: OAuthTokens | null } = {
      current: initial,
      load: async () => store.current,
      save: async (t: OAuthTokens) => {
        store.current = t;
      },
      clear: async () => {
        store.current = null;
      },
    };
    return store;
  };

  it("refreshes against the Codex token endpoint and stores the JWT expiry", async () => {
    const store = memory({ accessToken: "old", refreshToken: "rt-old", idToken: ID_TOKEN, expiresAt: 0 });
    const fetchImpl = vi.fn<FetchLike>(async () => response(200, { access_token: ACCESS_TOKEN }));
    const refresher = createChatgptTokenRefresher({ store, fetch: fetchImpl, now: () => 1_000 });
    const tokens = await refresher.getValidTokens();
    expect(tokens.accessToken).toBe(ACCESS_TOKEN);
    expect(store.current?.expiresAt).toBe(1_900_000_000_000);
    expect(store.current?.refreshToken).toBe("rt-old");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(CHATGPT_TOKEN_URL);
    // As Codex: a JSON body with these four fields, and the originator header.
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers.originator).toBe("atomic_agent");
    expect(JSON.parse(init.body)).toEqual({
      client_id: CHATGPT_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: "rt-old",
      refresh_reason: "proactive_expiry",
    });
  });

  it("a refresh after a 401 says unauthorized_recovery, as Codex does", async () => {
    const store = memory({ accessToken: "old", refreshToken: "rt-old", idToken: ID_TOKEN, expiresAt: 0 });
    const fetchImpl = vi.fn<FetchLike>(async () => response(200, { access_token: ACCESS_TOKEN }));
    const refresher = createChatgptTokenRefresher({ store, fetch: fetchImpl, now: () => 1_000 });
    await refresher.refresh();
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).refresh_reason).toBe("unauthorized_recovery");
  });

  it("a refused refresh token asks for a new sign-in", async () => {
    const store = memory({ accessToken: "old", refreshToken: "rt", expiresAt: 0 });
    const fetchImpl = vi.fn<FetchLike>(async () => response(400, { error: "invalid_grant" }));
    const refresher = createChatgptTokenRefresher({ store, fetch: fetchImpl, now: () => 1_000 });
    await expect(refresher.refresh()).rejects.toBeInstanceOf(SignInRequiredError);
  });
});
