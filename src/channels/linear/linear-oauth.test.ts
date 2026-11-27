import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { LinearApi, LinearApiError } from "./linear-api.js";
import {
  LINEAR_OAUTH_REDIRECT_URI,
  buildLinearAuthorizeUrl,
  exchangeLinearCode,
  linearTokenRefresher,
} from "./linear-oauth.js";

describe("buildLinearAuthorizeUrl (ATO-2464)", () => {
  it("asks for an app install with the agent scopes and our state", () => {
    const url = new URL(buildLinearAuthorizeUrl("client-1", "s123"));
    expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize");
    expect(url.searchParams.get("actor")).toBe("app");
    expect(url.searchParams.get("scope")).toBe("read,write,app:assignable,app:mentionable");
    expect(url.searchParams.get("state")).toBe("s123");
    expect(url.searchParams.get("redirect_uri")).toBe(LINEAR_OAUTH_REDIRECT_URI);
  });
});

describe("exchangeLinearCode", () => {
  it("posts the code as a form and returns both tokens", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: "a", refresh_token: "r" }), { status: 200 }));
    const tokens = await exchangeLinearCode({ clientId: "c", clientSecret: "s", code: "k" }, fetchImpl as never);
    expect(tokens).toEqual({ accessToken: "a", refreshToken: "r" });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    const form = new URLSearchParams(String(init.body));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("k");
  });

  it("rejects without saying the secret when Linear refuses", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    await expect(exchangeLinearCode({ clientId: "c", clientSecret: "topsecret", code: "k" }, fetchImpl as never)).rejects.toThrow(
      /invalid_grant/,
    );
  });
});

describe("linearTokenRefresher", () => {
  it("is null for a personal key install", () => {
    expect(linearTokenRefresher("/state", undefined, {})).toBeNull();
    expect(linearTokenRefresher("/state", "client-1", { LINEAR_OAUTH_CLIENT_SECRET: "s" })).toBeNull();
  });

  it("trades the refresh token and saves the new pair", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "linear-oauth-"));
    const env: NodeJS.ProcessEnv = { LINEAR_OAUTH_CLIENT_SECRET: "s", LINEAR_OAUTH_REFRESH_TOKEN: "r1" };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: "a2", refresh_token: "r2" }), { status: 200 }));
    const refresh = linearTokenRefresher(stateDir, "client-1", env, fetchImpl as never)!;
    expect(await refresh()).toBe("a2");
    expect(env.LINEAR_API_KEY).toBe("a2");
    expect(env.LINEAR_OAUTH_REFRESH_TOKEN).toBe("r2");
    const dotenv = readFileSync(join(stateDir, ".env"), "utf8");
    expect(dotenv).toContain("LINEAR_API_KEY=a2");
    expect(dotenv).toContain("LINEAR_OAUTH_REFRESH_TOKEN=r2");
  });
});

describe("LinearApi token refresh", () => {
  it("renews once on a refused token and retries with the new one", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization!;
      seen.push(auth);
      return auth === "Bearer old"
        ? new Response(JSON.stringify({ errors: [{ extensions: { code: "AUTHENTICATION_ERROR" } }] }), { status: 400 })
        : new Response(JSON.stringify({ data: { viewer: { id: "app", name: "A" } } }), { status: 200 });
    });
    const refresh = vi.fn(async () => "new");
    const api = new LinearApi({ apiKey: "old", refresh, fetchImpl: fetchImpl as never });
    expect((await api.viewer()).id).toBe("app");
    expect(seen).toEqual(["Bearer old", "Bearer new"]);
    expect(api.currentKey()).toBe("new");
  });

  it("reports the refusal when renewal is not possible", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
    const api = new LinearApi({ apiKey: "old", refresh: async () => null, fetchImpl: fetchImpl as never });
    await expect(api.viewer()).rejects.toBeInstanceOf(LinearApiError);
  });
});
