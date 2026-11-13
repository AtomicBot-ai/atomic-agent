import { createHash } from "node:crypto";
import { createServer } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { OAuthFlowError } from "./oauth-errors.js";
import { startBrowserLogin } from "./oauth-login.js";
import type { FetchLike } from "./oauth-types.js";

const BASE = {
  authorizeUrl: "https://auth.example.test/authorize",
  tokenUrl: "https://auth.example.test/token",
  clientId: "client-under-test",
  scope: "openid offline_access",
  timeoutMs: 5_000,
};

function jsonResponse(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}

function tokenFetch(status = 200, body: unknown = {
  access_token: "access-secret",
  refresh_token: "refresh-secret",
  expires_in: 3600,
}) {
  return vi.fn<FetchLike>(async () => jsonResponse(status, body));
}

function hit(redirectUri: string, params: Record<string, string>) {
  return fetch(`${redirectUri}?${new URLSearchParams(params).toString()}`);
}

function stateOf(url: string): string {
  return new URL(url).searchParams.get("state") ?? "";
}

function portOf(uri: string): number {
  return Number(new URL(uri).port);
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

describe("startBrowserLogin", () => {
  it("sends an S256 challenge and exchanges the code with the matching verifier", async () => {
    const fetchImpl = tokenFetch();
    const login = await startBrowserLogin({ ...BASE, fetch: fetchImpl, now: () => 1_000 });
    const url = new URL(login.authorizationUrl);
    expect(url.origin + url.pathname).toBe(BASE.authorizeUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe(BASE.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(login.redirectUri);
    expect(login.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const res = await hit(login.redirectUri, { code: "auth-code", state: stateOf(login.authorizationUrl) });
    expect(res.status).toBe(200);
    await expect(login.tokens).resolves.toEqual({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: 1_000 + 3_600_000,
    });

    const body = new URLSearchParams(fetchImpl.mock.calls[0]![1].body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("redirect_uri")).toBe(login.redirectUri);
    const challenge = createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url");
    expect(challenge).toBe(url.searchParams.get("code_challenge"));
    expect(await portIsFree(portOf(login.redirectUri))).toBe(true);
  });

  it("does not let extra params override the security parameters", async () => {
    const login = await startBrowserLogin({
      ...BASE,
      fetch: tokenFetch(),
      extraAuthorizeParams: { state: "attacker", code_challenge_method: "plain", prompt: "login" },
    });
    const url = new URL(login.authorizationUrl);
    expect(url.searchParams.get("state")).not.toBe("attacker");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("prompt")).toBe("login");
    login.cancel();
    await expect(login.tokens).rejects.toMatchObject({ code: "cancelled" });
  });

  it("rejects a forged state without calling the token endpoint and closes", async () => {
    const fetchImpl = tokenFetch();
    const login = await startBrowserLogin({ ...BASE, fetch: fetchImpl });
    const res = await hit(login.redirectUri, { code: "auth-code", state: "forged" });
    expect(res.status).toBe(400);
    await expect(login.tokens).rejects.toMatchObject({ code: "state_mismatch" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await portIsFree(portOf(login.redirectUri))).toBe(true);
  });

  it("rejects a second hit on the callback while the first is being exchanged", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn<FetchLike>(async () => {
      await gate;
      return jsonResponse(200, { access_token: "access-secret" });
    });
    const login = await startBrowserLogin({ ...BASE, fetch: fetchImpl });
    const state = stateOf(login.authorizationUrl);
    const first = hit(login.redirectUri, { code: "first", state });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    const second = await hit(login.redirectUri, { code: "second", state });
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    await expect(login.tokens).resolves.toMatchObject({ accessToken: "access-secret" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("times out, rejects and frees the port", async () => {
    const login = await startBrowserLogin({ ...BASE, timeoutMs: 30, fetch: tokenFetch() });
    await expect(login.tokens).rejects.toMatchObject({ code: "callback_timeout" });
    expect(await portIsFree(portOf(login.redirectUri))).toBe(true);
  });

  it("reports a provider error by code only", async () => {
    const login = await startBrowserLogin({ ...BASE, fetch: tokenFetch() });
    const res = await hit(login.redirectUri, {
      error: "access_denied",
      error_description: "<script>leak</script>",
      state: stateOf(login.authorizationUrl),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("leak");
    await expect(login.tokens).rejects.toMatchObject({ code: "authorization_denied", oauthError: "access_denied" });
  });

  it("keeps the code and server text out of a failed exchange error", async () => {
    const fetchImpl = tokenFetch(400, { error: "invalid_grant", error_description: "code auth-code-xyz is bad" });
    const login = await startBrowserLogin({ ...BASE, fetch: fetchImpl });
    await hit(login.redirectUri, { code: "auth-code-xyz", state: stateOf(login.authorizationUrl) });
    const error = await login.tokens.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OAuthFlowError);
    expect(error).toMatchObject({ code: "token_request_failed", status: 400, oauthError: "invalid_grant" });
    expect(String((error as Error).message)).not.toContain("auth-code-xyz");
  });

  it("ignores other paths and stops on abort", async () => {
    const controller = new AbortController();
    const login = await startBrowserLogin({ ...BASE, fetch: tokenFetch(), signal: controller.signal });
    const other = await fetch(login.redirectUri.replace("/callback", "/favicon.ico"));
    expect(other.status).toBe(404);
    controller.abort();
    await expect(login.tokens).rejects.toMatchObject({ code: "cancelled" });
    expect(await portIsFree(portOf(login.redirectUri))).toBe(true);
  });
});
