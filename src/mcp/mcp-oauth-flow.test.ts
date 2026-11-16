import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { McpOAuthFlow, McpOAuthFlowError } from "./mcp-oauth-flow.js";
import type { McpOAuthProvider } from "./mcp-oauth-provider.js";
import { createMcpOAuthStore } from "./mcp-oauth-store.js";
import type { McpServerConfig } from "./mcp-types.js";

const URL_A = "https://mcp.example.com/v1";

const SERVERS: Record<string, McpServerConfig> = {
  monid: { name: "monid", enabled: true, transport: { kind: "streamable_http", url: URL_A } },
  local: { name: "local", enabled: true, transport: { kind: "stdio", command: "npx" } },
  keyed: {
    name: "keyed",
    enabled: true,
    transport: { kind: "streamable_http", url: URL_A, headers: { Authorization: "Bearer k" } },
  },
};

/** Stands in for the SDK's `auth()`: no network, same provider calls. */
function fakeAuthorize(opts: { failExchange?: boolean } = {}) {
  return vi.fn(
    async (
      provider: McpOAuthProvider,
      o: { serverUrl: string; authorizationCode?: string },
    ): Promise<"AUTHORIZED" | "REDIRECT"> => {
      if (o.authorizationCode === undefined) {
        if (!provider.clientInformation()) provider.saveClientInformation({ client_id: "c1" } as never);
        const state = provider.state();
        provider.saveCodeVerifier("verifier");
        const u = new URL("https://auth.example.com/authorize");
        u.searchParams.set("state", state);
        u.searchParams.set("redirect_uri", provider.redirectUrl);
        provider.redirectToAuthorization(u);
        return "REDIRECT";
      }
      if (opts.failExchange) throw new Error("invalid_grant");
      expect(provider.codeVerifier()).toBe("verifier");
      provider.saveTokens({ access_token: `tok-${o.authorizationCode}`, token_type: "Bearer" });
      return "AUTHORIZED";
    },
  );
}

describe("McpOAuthFlow", () => {
  let stateDir: string;
  let flow: McpOAuthFlow | null = null;
  const reconnect = vi.fn(async (_name: string) => {});

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-mcp-oauth-flow-"));
    reconnect.mockClear();
  });

  afterEach(async () => {
    await flow?.dispose();
    flow = null;
    rmSync(stateDir, { recursive: true, force: true });
  });

  function makeFlow(extra: Partial<ConstructorParameters<typeof McpOAuthFlow>[0]> = {}): McpOAuthFlow {
    flow = new McpOAuthFlow({
      stateDir,
      findServer: (n) => SERVERS[n],
      reconnect,
      ports: [0],
      authorize: fakeAuthorize(),
      ...extra,
    });
    return flow;
  }

  async function startPending(f: McpOAuthFlow): Promise<{ authUrl: URL; redirect: URL }> {
    const result = await f.start("monid");
    if (result.state !== "pending") throw new Error("expected a pending sign-in");
    const authUrl = new URL(result.authUrl);
    return { authUrl, redirect: new URL(authUrl.searchParams.get("redirect_uri")!) };
  }

  it("start hands back the authorization URL and a loopback redirect", async () => {
    const f = makeFlow();
    const { authUrl, redirect } = await startPending(f);
    expect(authUrl.origin).toBe("https://auth.example.com");
    expect(redirect.hostname).toBe("127.0.0.1");
    expect(redirect.pathname).toBe("/callback");
    expect(Number(redirect.port)).toBe(f.callbackPort);
    expect(f.status("monid")).toEqual({ state: "pending" });
  });

  it("refuses a callback whose state it did not hand out", async () => {
    const f = makeFlow();
    const { redirect } = await startPending(f);
    redirect.searchParams.set("code", "abc");
    redirect.searchParams.set("state", "forged");
    const res = await fetch(redirect);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/expired or was already used/);
    expect(f.status("monid").state).toBe("pending");
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("finishes the sign-in on a valid callback and reconnects the server", async () => {
    const f = makeFlow();
    const { authUrl, redirect } = await startPending(f);
    redirect.searchParams.set("code", "abc");
    redirect.searchParams.set("state", authUrl.searchParams.get("state")!);
    const res = await fetch(redirect);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/You can close this tab and return to Atomic Agent/);
    await vi.waitFor(() => expect(reconnect).toHaveBeenCalledWith("monid"));
    expect(f.status("monid")).toEqual({ state: "signed_in" });
    expect(createMcpOAuthStore(stateDir).load("monid", URL_A).tokens?.access_token).toBe("tok-abc");
    // One valid callback only: the same link again is refused.
    const again = await fetch(redirect).catch(() => null);
    if (again) expect(again.status).toBe(400);
  });

  it("reports a refused sign-in as a plain sentence", async () => {
    const f = makeFlow();
    const { authUrl, redirect } = await startPending(f);
    redirect.searchParams.set("error", "access_denied");
    redirect.searchParams.set("error_description", "The user said no");
    redirect.searchParams.set("state", authUrl.searchParams.get("state")!);
    const res = await fetch(redirect);
    expect(res.status).toBe(400);
    expect(f.status("monid")).toEqual({
      state: "signed_out",
      error: "Sign-in was not completed: The user said no",
    });
  });

  it("reports a failed code exchange", async () => {
    const f = makeFlow({ authorize: fakeAuthorize({ failExchange: true }) });
    const { authUrl, redirect } = await startPending(f);
    redirect.searchParams.set("code", "abc");
    redirect.searchParams.set("state", authUrl.searchParams.get("state")!);
    expect((await fetch(redirect)).status).toBe(400);
    const status = f.status("monid");
    expect(status.state).toBe("signed_out");
    expect(status.error).toMatch(/did not accept the sign-in/);
  });

  it("expires a sign-in nobody finished and closes the listener", async () => {
    const f = makeFlow({ timeoutMs: 20 });
    await startPending(f);
    await vi.waitFor(() => expect(f.status("monid").state).toBe("signed_out"));
    expect(f.status("monid").error).toMatch(/timed out/);
    await vi.waitFor(() => expect(f.callbackPort).toBeNull());
  });

  it("refuses stdio servers, keyed servers and unknown names", async () => {
    const f = makeFlow();
    await expect(f.start("local")).rejects.toMatchObject({ code: "not_remote" });
    await expect(f.start("keyed")).rejects.toMatchObject({ code: "uses_key" });
    await expect(f.start("nope")).rejects.toBeInstanceOf(McpOAuthFlowError);
    expect(() => f.status("nope")).toThrow(/no MCP server named/);
  });

  it("sign out deletes the saved sign-in and reconnects", async () => {
    createMcpOAuthStore(stateDir).update("monid", URL_A, { tokens: { access_token: "tok" } });
    const f = makeFlow();
    expect(f.status("monid").state).toBe("signed_in");
    await f.signOut("monid");
    expect(f.status("monid").state).toBe("signed_out");
    expect(reconnect).toHaveBeenCalledWith("monid");
  });

  it("a refreshed token signs in without a browser", async () => {
    const authorize = vi.fn(async () => "AUTHORIZED" as const);
    const f = makeFlow({ authorize });
    await expect(f.start("monid")).resolves.toEqual({ state: "signed_in" });
    expect(reconnect).toHaveBeenCalledWith("monid");
  });
});
