import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMcpOAuthStore, MCP_OAUTH_DIR, mcpOAuthFilePath } from "./mcp-oauth-store.js";

const URL_A = "https://mcp.example.com/v1";
const URL_B = "https://mcp.example.com/v2";

describe("mcp-oauth-store", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-mcp-oauth-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("round-trips a record", () => {
    const store = createMcpOAuthStore(stateDir);
    store.update("monid", URL_A, {
      clientInformation: { client_id: "abc" },
      redirectUri: "http://127.0.0.1:47613/callback",
      tokens: { access_token: "tok", token_type: "Bearer", refresh_token: "ref" },
      codeVerifier: "verifier",
    });
    const rec = createMcpOAuthStore(stateDir).load("monid", URL_A);
    expect(rec.url).toBe(URL_A);
    expect(rec.clientInformation).toEqual({ client_id: "abc" });
    expect(rec.tokens?.access_token).toBe("tok");
    expect(rec.codeVerifier).toBe("verifier");
    expect(store.hasTokens("monid", URL_A)).toBe(true);
  });

  it("removes fields patched to undefined", () => {
    const store = createMcpOAuthStore(stateDir);
    store.update("monid", URL_A, { codeVerifier: "v", pendingAuthUrl: "https://a/b" });
    store.update("monid", URL_A, { codeVerifier: undefined });
    const rec = store.load("monid", URL_A);
    expect(rec.codeVerifier).toBeUndefined();
    expect(rec.pendingAuthUrl).toBe("https://a/b");
    expect("codeVerifier" in rec).toBe(false);
  });

  it.skipIf(process.platform === "win32")("writes the file with mode 0600 and no temp file left", () => {
    const store = createMcpOAuthStore(stateDir);
    store.update("monid", URL_A, { tokens: { access_token: "tok" } });
    const file = mcpOAuthFilePath(stateDir, "monid");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(stateDir, MCP_OAUTH_DIR)).mode & 0o077).toBe(0);
    expect(readdirSync(join(stateDir, MCP_OAUTH_DIR))).toEqual(["monid.json"]);
  });

  it("drops credentials when the server URL changes", () => {
    const store = createMcpOAuthStore(stateDir);
    store.update("monid", URL_A, { tokens: { access_token: "tok" } });
    expect(store.hasTokens("monid", URL_B)).toBe(false);
    expect(store.load("monid", URL_B)).toEqual({ url: URL_B });
    store.update("monid", URL_B, { codeVerifier: "v" });
    // The old URL's tokens are gone, not kept beside the new record.
    expect(store.hasTokens("monid", URL_A)).toBe(false);
  });

  it("clear deletes everything for the server", () => {
    const store = createMcpOAuthStore(stateDir);
    store.update("monid", URL_A, { tokens: { access_token: "tok" } });
    store.clear("monid");
    expect(store.hasTokens("monid", URL_A)).toBe(false);
    expect(() => store.clear("monid")).not.toThrow();
  });

  it("reads a torn file as signed out", () => {
    mkdirSync(join(stateDir, MCP_OAUTH_DIR), { recursive: true });
    writeFileSync(mcpOAuthFilePath(stateDir, "monid"), "{not json");
    const store = createMcpOAuthStore(stateDir);
    expect(store.load("monid", URL_A)).toEqual({ url: URL_A });
  });

  it("refuses a name that could escape the folder", () => {
    expect(() => mcpOAuthFilePath(stateDir, "../evil")).toThrow(/invalid MCP server name/);
  });
});
