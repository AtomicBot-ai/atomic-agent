import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hasStaticCredentialHeader,
  MCP_OAUTH_DEFAULT_REDIRECT_URI,
  McpOAuthProvider,
  mcpOAuthRedirectUri,
  usesMcpOAuth,
} from "./mcp-oauth-provider.js";
import { createMcpOAuthStore, type McpOAuthStore } from "./mcp-oauth-store.js";

const URL_A = "https://mcp.example.com/v1";

describe("usesMcpOAuth", () => {
  it("applies to remote servers without a credential header", () => {
    expect(usesMcpOAuth({ kind: "streamable_http", url: URL_A })).toBe(true);
    expect(usesMcpOAuth({ kind: "sse", url: URL_A, headers: { "X-Client": "a" } })).toBe(true);
  });

  it("never applies to stdio", () => {
    expect(usesMcpOAuth({ kind: "stdio", command: "npx" })).toBe(false);
  });

  it("keeps a configured Authorization header untouched", () => {
    expect(
      usesMcpOAuth({ kind: "streamable_http", url: URL_A, headers: { Authorization: "Bearer x" } }),
    ).toBe(false);
    expect(
      usesMcpOAuth({ kind: "sse", url: URL_A, headers: { authorization: "Bearer x" } }),
    ).toBe(false);
  });

  it("treats key-shaped header names as credentials", () => {
    for (const name of ["x-api-key", "X-API-KEY", "Api-Key", "X-Auth-Token", "client_secret"]) {
      expect(hasStaticCredentialHeader({ [name]: "v" })).toBe(true);
    }
    expect(hasStaticCredentialHeader({ "User-Agent": "a" })).toBe(false);
    expect(hasStaticCredentialHeader(undefined)).toBe(false);
  });
});

describe("McpOAuthProvider", () => {
  let stateDir: string;
  let store: McpOAuthStore;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-mcp-oauth-provider-"));
    store = createMcpOAuthStore(stateDir);
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("registers as a public client on the loopback redirect", () => {
    const p = new McpOAuthProvider({ store, server: "monid", url: URL_A, mode: "connect" });
    expect(p.redirectUrl).toBe(MCP_OAUTH_DEFAULT_REDIRECT_URI);
    expect(MCP_OAUTH_DEFAULT_REDIRECT_URI).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(p.clientMetadata).toEqual({
      client_name: "Atomic Agent",
      redirect_uris: [MCP_OAUTH_DEFAULT_REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  it("connect mode reuses the redirect the saved client was registered with", () => {
    const redirect = mcpOAuthRedirectUri(50001);
    store.update("monid", URL_A, { clientInformation: { client_id: "c" }, redirectUri: redirect });
    const p = new McpOAuthProvider({ store, server: "monid", url: URL_A, mode: "connect" });
    expect(p.redirectUrl).toBe(redirect);
    expect(p.clientInformation()).toEqual({ client_id: "c" });
  });

  it("signin mode registers again when its redirect differs", () => {
    store.update("monid", URL_A, {
      clientInformation: { client_id: "c" },
      redirectUri: mcpOAuthRedirectUri(50001),
    });
    const other = new McpOAuthProvider({
      store, server: "monid", url: URL_A, mode: "signin", redirectUri: mcpOAuthRedirectUri(50002),
    });
    expect(other.clientInformation()).toBeUndefined();
    const same = new McpOAuthProvider({
      store, server: "monid", url: URL_A, mode: "signin", redirectUri: mcpOAuthRedirectUri(50001),
    });
    expect(same.clientInformation()).toEqual({ client_id: "c" });
  });

  it("saves the client with the redirect it used", () => {
    const redirect = mcpOAuthRedirectUri(50003);
    const p = new McpOAuthProvider({ store, server: "monid", url: URL_A, mode: "signin", redirectUri: redirect });
    p.saveClientInformation({ client_id: "new" } as never);
    expect(store.load("monid", URL_A).redirectUri).toBe(redirect);
  });

  it("signin mode records the authorization request instead of opening a browser", () => {
    const p = new McpOAuthProvider({ store, server: "monid", url: URL_A, mode: "signin" });
    const state = p.state();
    p.saveCodeVerifier("verifier");
    p.redirectToAuthorization(new URL(`https://auth.example.com/authorize?state=${state}`));
    expect(p.pendingAuthorization()).toEqual({
      authUrl: `https://auth.example.com/authorize?state=${state}`,
      state,
    });
    expect(p.codeVerifier()).toBe("verifier");
    expect(store.load("monid", URL_A).pendingAuthUrl).toContain("auth.example.com");
  });

  it("connect mode leaves a sign-in in progress alone", () => {
    store.update("monid", URL_A, { codeVerifier: "from-signin" });
    const p = new McpOAuthProvider({ store, server: "monid", url: URL_A, mode: "connect" });
    p.state();
    p.saveCodeVerifier("from-connect");
    p.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
    expect(p.signInRequested).toBe(true);
    expect(p.pendingAuthorization()).toBeNull();
    expect(store.load("monid", URL_A).codeVerifier).toBe("from-signin");
  });

  it("state values are unique", () => {
    const p = new McpOAuthProvider({ store, server: "monid", url: URL_A, mode: "signin" });
    expect(p.state()).not.toBe(p.state());
  });

  it("saving tokens clears the verifier and the pending URL", () => {
    store.update("monid", URL_A, { codeVerifier: "v", pendingAuthUrl: "https://a" });
    const p = new McpOAuthProvider({ store, server: "monid", url: URL_A, mode: "signin" });
    p.saveTokens({ access_token: "tok", token_type: "Bearer" });
    const rec = store.load("monid", URL_A);
    expect(p.tokens()).toEqual({ access_token: "tok", token_type: "Bearer" });
    expect(rec.codeVerifier).toBeUndefined();
    expect(rec.pendingAuthUrl).toBeUndefined();
  });

  it("invalidateCredentials drops what the server rejected", () => {
    store.update("monid", URL_A, {
      clientInformation: { client_id: "c" },
      tokens: { access_token: "tok" },
    });
    const p = new McpOAuthProvider({ store, server: "monid", url: URL_A, mode: "connect" });
    p.invalidateCredentials("tokens");
    expect(p.tokens()).toBeUndefined();
    expect(p.clientInformation()).toEqual({ client_id: "c" });
    p.invalidateCredentials("all");
    expect(p.clientInformation()).toBeUndefined();
  });
});
