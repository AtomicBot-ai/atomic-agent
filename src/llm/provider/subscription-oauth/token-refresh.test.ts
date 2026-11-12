import { describe, expect, it, vi } from "vitest";

import { SignInRequiredError } from "./oauth-errors.js";
import type { FetchLike, OAuthTokens, TokenStore } from "./oauth-types.js";
import { createTokenRefresher } from "./token-refresh.js";

function memoryStore(initial: OAuthTokens | null): TokenStore & { current: OAuthTokens | null } {
  const store = {
    current: initial,
    load: async () => store.current,
    save: async (tokens: OAuthTokens) => { store.current = tokens; },
    clear: async () => { store.current = null; },
  };
  return store;
}

function jsonResponse(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}

const NOW = 1_000_000;
const setup = (tokens: OAuthTokens | null, status = 200, body: unknown = { access_token: "new-access", expires_in: 3600 }) => {
  const store = memoryStore(tokens);
  const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(status, body));
  const refresher = createTokenRefresher({
    store,
    tokenUrl: "https://auth.example.test/token",
    clientId: "client-under-test",
    fetch: fetchImpl,
    now: () => NOW,
  });
  return { store, fetchImpl, refresher };
};

describe("createTokenRefresher", () => {
  it("returns stored tokens untouched while they are fresh", async () => {
    const tokens = { accessToken: "a", refreshToken: "r", expiresAt: NOW + 10 * 60_000 };
    const { fetchImpl, refresher } = setup(tokens);
    await expect(refresher.getValidTokens()).resolves.toBe(tokens);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes an expired token, saves it and keeps a non-rotated refresh token", async () => {
    const { store, fetchImpl, refresher } = setup({ accessToken: "old", refreshToken: "refresh-secret", expiresAt: NOW - 1 });
    const tokens = await refresher.getValidTokens();
    expect(tokens).toEqual({ accessToken: "new-access", refreshToken: "refresh-secret", expiresAt: NOW + 3_600_000 });
    expect(store.current).toEqual(tokens);
    const body = new URLSearchParams(fetchImpl.mock.calls[0]![1].body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-secret");
  });

  it("refreshes inside the skew window", async () => {
    const { fetchImpl, refresher } = setup({ accessToken: "old", refreshToken: "r", expiresAt: NOW + 30_000 });
    await refresher.getValidTokens();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("shares one request between concurrent refreshes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { fetchImpl, refresher } = setup({ accessToken: "old", refreshToken: "r", expiresAt: NOW - 1 });
    fetchImpl.mockImplementation(async () => {
      await gate;
      return jsonResponse(200, { access_token: "new-access", refresh_token: "r2" });
    });
    const calls = [refresher.getValidTokens(), refresher.getValidTokens(), refresher.refresh()];
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    release();
    const results = await Promise.all(calls);
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toMatchObject({ accessToken: "new-access", refreshToken: "r2" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("turns invalid_grant into a sign-in-again error without leaking tokens", async () => {
    const { refresher } = setup(
      { accessToken: "old", refreshToken: "refresh-secret", expiresAt: NOW - 1 },
      400,
      { error: "invalid_grant", error_description: "refresh-secret revoked" },
    );
    const error = await refresher.getValidTokens().catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(SignInRequiredError);
    expect(error).toMatchObject({ reason: "refresh_refused" });
    expect(error.message).not.toContain("refresh-secret");
  });

  it("asks to sign in when nothing can be refreshed", async () => {
    await expect(setup(null).refresher.getValidTokens()).rejects.toMatchObject({ reason: "no_tokens" });
    await expect(setup({ accessToken: "a", expiresAt: NOW - 1 }).refresher.getValidTokens())
      .rejects.toMatchObject({ reason: "no_refresh_token" });
  });

  it("keeps other server failures as a flow error, so a retry stays possible", async () => {
    const { refresher } = setup({ accessToken: "a", refreshToken: "r", expiresAt: NOW - 1 }, 503, { error: "temporarily_unavailable" });
    await expect(refresher.getValidTokens()).rejects.toMatchObject({ code: "token_request_failed", status: 503 });
  });
});
