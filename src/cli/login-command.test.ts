import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OAuthFlowError,
  createFileTokenStore,
  subscriptionTokenPath,
  type BrowserLogin,
  type FileTokenStore,
  type OAuthTokens,
} from "../llm/provider/subscription-oauth/index.js";
import { describeLoginFailure, loginCommand, logoutCommand } from "./login-command.js";

const jwt = (payload: Record<string, unknown>): string =>
  [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");

const TOKENS: OAuthTokens = {
  accessToken: jwt({ exp: 1_900_000_000 }),
  refreshToken: "rt_secret_refresh_value_123",
  idToken: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "pro" } }),
  expiresAt: 1_900_000_000_000,
};

describe("atomic-agent login / logout chatgpt (ATO-1454)", () => {
  let dir: string;
  let store: FileTokenStore;
  let out: string;
  const write = (t: string) => {
    out += t;
  };
  const ensureProviderEntry = vi.fn((_model: string) => ({ id: "chatgpt-sub", added: true }));
  // No network and no real config in these tests.
  const defaultModel = vi.fn(async () => ({ model: "codex-default-x", source: "backend" as const }));
  const setActive = vi.fn((_id: string) => {});
  const quiet = { defaultModel, setActive, activation: () => "already-active" as const };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "login-cmd-"));
    store = createFileTokenStore({ path: subscriptionTokenPath(dir, "chatgpt") });
    out = "";
    ensureProviderEntry.mockClear();
    defaultModel.mockClear();
    setActive.mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints usage and exits 2 without a target", async () => {
    expect(await loginCommand([], { write })).toBe(2);
    expect(out).toContain("login chatgpt");
    expect(out).toMatch(/experimental/i);
  });

  it("refuses an unknown service or option", async () => {
    expect(await loginCommand(["claude"], { write })).toBe(2);
    expect(await loginCommand(["chatgpt", "--nope"], { write })).toBe(2);
  });

  it("browser sign-in stores the tokens, adds the provider, and prints no token", async () => {
    const login: BrowserLogin = {
      authorizationUrl: "https://auth.openai.com/oauth/authorize?x=1",
      redirectUri: "http://localhost:1455/auth/callback",
      tokens: Promise.resolve(TOKENS),
      cancel: vi.fn(),
    };
    const openUrl = vi.fn(async () => ({ ok: true }));
    const code = await loginCommand(["chatgpt"], {
      write,
      store,
      startBrowser: async () => login,
      openUrl,
      ensureProviderEntry,
      ...quiet,
    });
    expect(code).toBe(0);
    expect(openUrl).toHaveBeenCalledWith(login.authorizationUrl);
    await expect(store.load()).resolves.toEqual(TOKENS);
    expect(ensureProviderEntry).toHaveBeenCalledTimes(1);
    expect(out).toContain("Signed in (ChatGPT pro)");
    expect(out).toContain('Added provider "chatgpt-sub"');
    expect(out).not.toContain(TOKENS.accessToken);
    expect(out).not.toContain(TOKENS.refreshToken!);
  });

  it("--no-browser prints the link instead of opening it", async () => {
    const openUrl = vi.fn(async () => ({ ok: true }));
    await loginCommand(["chatgpt", "--no-browser"], {
      write,
      store,
      startBrowser: async () => ({
        authorizationUrl: "https://auth.openai.com/oauth/authorize?y=2",
        redirectUri: "",
        tokens: Promise.resolve(TOKENS),
        cancel: vi.fn(),
      }),
      openUrl,
      ensureProviderEntry,
      ...quiet,
    });
    expect(openUrl).not.toHaveBeenCalled();
    expect(out).toContain("https://auth.openai.com/oauth/authorize?y=2");
  });

  it("--device prints the link and code, then stores the tokens", async () => {
    const code = await loginCommand(["chatgpt", "--device"], {
      write,
      store,
      requestDevice: async () => ({
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "WXYZ-1234",
        deviceAuthId: "opaque-device-id",
        intervalMs: 5_000,
      }),
      completeDevice: async () => TOKENS,
      ensureProviderEntry,
      ...quiet,
    });
    expect(code).toBe(0);
    expect(out).toContain("https://auth.openai.com/codex/device");
    expect(out).toContain("WXYZ-1234");
    expect(out).not.toContain("opaque-device-id");
    await expect(store.load()).resolves.toEqual(TOKENS);
  });

  it("a failed sign-in exits 1 with one sentence and stores nothing", async () => {
    const code = await loginCommand(["chatgpt"], {
      write,
      store,
      startBrowser: async () => {
        throw new OAuthFlowError("callback_port_unavailable");
      },
      ensureProviderEntry,
      ...quiet,
    });
    expect(code).toBe(1);
    expect(out).toMatch(/1455 and 1457/);
    await expect(store.load()).resolves.toBeNull();
    expect(ensureProviderEntry).not.toHaveBeenCalled();
  });

  const browser = (): BrowserLogin => ({
    authorizationUrl: "https://auth.openai.com/oauth/authorize?z=3",
    redirectUri: "",
    tokens: Promise.resolve(TOKENS),
    cancel: vi.fn(),
  });

  it("writes Codex's current default model into the new entry (Nadya 18.11)", async () => {
    await loginCommand(["chatgpt", "--no-browser"], { write, store, startBrowser: async () => browser(), ensureProviderEntry, ...quiet });
    expect(defaultModel).toHaveBeenCalledWith(TOKENS);
    expect(ensureProviderEntry).toHaveBeenCalledWith("codex-default-x");
    expect(out).toContain("model codex-default-x (Codex's current default)");
  });

  it("makes ChatGPT active at once when it is the only provider", async () => {
    await loginCommand(["chatgpt", "--no-browser"], {
      write, store, startBrowser: async () => browser(), ensureProviderEntry, ...quiet,
      activation: () => "only-provider",
      ask: vi.fn(async () => "n"),
    });
    expect(setActive).toHaveBeenCalledWith("chatgpt-sub");
    expect(out).toContain('"chatgpt-sub" is now the active provider.');
  });

  it("asks 'Use ChatGPT now?' when other providers exist, and follows the answer", async () => {
    const ask = vi.fn(async () => "y");
    await loginCommand(["chatgpt", "--no-browser"], {
      write, store, startBrowser: async () => browser(), ensureProviderEntry, ...quiet,
      activation: () => "has-others", ask,
    });
    expect(ask).toHaveBeenCalledWith("Use ChatGPT now? [y/N] ");
    expect(setActive).toHaveBeenCalledWith("chatgpt-sub");

    setActive.mockClear();
    out = "";
    await loginCommand(["chatgpt", "--no-browser"], {
      write, store, startBrowser: async () => browser(), ensureProviderEntry, ...quiet,
      activation: () => "has-others", ask: vi.fn(async () => ""),
    });
    expect(setActive).not.toHaveBeenCalled();
    expect(out).toContain("Kept your current provider.");
  });

  it("without a terminal it does not switch and says how to", async () => {
    await loginCommand(["chatgpt", "--no-browser"], {
      write, store, startBrowser: async () => browser(), ensureProviderEntry, ...quiet,
      activation: () => "has-others", ask: null,
    });
    expect(setActive).not.toHaveBeenCalled();
    expect(out).toContain('pick "chatgpt-sub" in the Providers panel');
  });

  it("a new sign-in overwrites the stored one", async () => {
    await store.save({ ...TOKENS, refreshToken: "old_refresh" });
    await loginCommand(["chatgpt", "--no-browser"], { write, store, startBrowser: async () => browser(), ensureProviderEntry, ...quiet });
    await expect(store.load()).resolves.toEqual(TOKENS);
  });

  it("status says signed in or not, without the token", async () => {
    expect(await loginCommand(["status"], { write, store })).toBe(1);
    expect(out).toContain("not signed in");
    await store.save(TOKENS);
    out = "";
    expect(await loginCommand(["status", "--json"], { write, store })).toBe(0);
    const report = JSON.parse(out);
    expect(report).toMatchObject({ service: "chatgpt", experimental: true, signedIn: true, plan: "pro", canRenew: true });
    expect(out).not.toContain(TOKENS.refreshToken!);
  });

  it("logout deletes the stored sign-in, and is fine when signed out", async () => {
    await store.save(TOKENS);
    expect(await logoutCommand(["chatgpt"], { write, store })).toBe(0);
    await expect(store.load()).resolves.toBeNull();
    expect(out).toContain("Signed out");
    out = "";
    expect(await logoutCommand(["chatgpt"], { write, store })).toBe(0);
    expect(out).toContain("nothing to delete");
    expect(await logoutCommand(["claude"], { write, store })).toBe(2);
  });

  it("words each failure without the server's text", () => {
    expect(describeLoginFailure(new OAuthFlowError("cancelled"))).toBe("Sign-in cancelled.");
    expect(describeLoginFailure(new OAuthFlowError("token_request_failed", { status: 404, oauthError: "device_login_not_enabled" }))).toMatch(
      /Device sign-in is not enabled/,
    );
    expect(describeLoginFailure(new Error("secret body"))).toBe("Sign-in failed.");
  });
});
