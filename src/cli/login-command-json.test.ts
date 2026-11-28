import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ChatgptNoAccountError,
  OAuthFlowError,
  createFileTokenStore,
  subscriptionTokenPath,
  type BrowserLogin,
  type FileTokenStore,
  type OAuthTokens,
} from "../llm/provider/subscription-oauth/index.js";
import { loginCommand, type LoginCommandDeps } from "./login-command.js";

/** ATO-2510: `atag login chatgpt --json`, one JSON object per line for the desktop app. */

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

describe("atomic-agent login chatgpt --json (ATO-2510)", () => {
  let dir: string;
  let store: FileTokenStore;
  let out: string;
  const write = (t: string) => {
    out += t;
  };
  /** Every line must be JSON; returns them parsed. */
  const events = (): Array<Record<string, unknown>> =>
    out
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const browser = (tokens: Promise<OAuthTokens> = Promise.resolve(TOKENS)): BrowserLogin => {
    tokens.catch(() => {}); // a rejection is read later by the command, not "unhandled"
    return { authorizationUrl: "https://auth.openai.com/oauth/authorize?j=1", redirectUri: "", tokens, cancel: vi.fn() };
  };
  const base = (): LoginCommandDeps => ({
    write,
    store,
    startBrowser: async () => browser(),
    ensureProviderEntry: () => ({ id: "chatgpt-sub", added: true }),
    defaultModel: async () => ({ model: "codex-default-x", source: "backend" as const }),
    setActive: () => {},
    activation: () => "already-active" as const,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "login-json-"));
    store = createFileTokenStore({ path: subscriptionTokenPath(dir, "chatgpt") });
    out = "";
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists --json on the `login chatgpt` usage line (the desktop probes for it)", async () => {
    await loginCommand(["--help"], { write });
    expect(out).toMatch(/login chatgpt [^\n]*--json/);
  });

  it("browser sign-in: authorization_url, then signed_in with the provider id; no banner, no token", async () => {
    expect(await loginCommand(["chatgpt", "--no-browser", "--json"], base())).toBe(0);
    const lines = events();
    expect(lines[0]).toEqual({ type: "authorization_url", url: "https://auth.openai.com/oauth/authorize?j=1", opened: false });
    expect(lines.at(-1)).toEqual({
      type: "signed_in",
      providerId: "chatgpt-sub",
      providerAdded: true,
      model: "codex-default-x",
      modelSource: "backend",
      plan: "pro",
    });
    expect(out).not.toContain("experimental; the Codex CLI");
    expect(out).not.toContain(TOKENS.accessToken);
    expect(out).not.toContain(TOKENS.refreshToken!);
  });

  it("says opened: true when the browser was opened, and a reused entry is providerAdded: false", async () => {
    await loginCommand(["chatgpt", "--json"], {
      ...base(),
      openUrl: async () => ({ ok: true }),
      ensureProviderEntry: () => ({ id: "my-chatgpt", added: false }),
    });
    const lines = events();
    expect(lines[0]).toMatchObject({ type: "authorization_url", opened: true });
    expect(lines.at(-1)).toMatchObject({ type: "signed_in", providerId: "my-chatgpt", providerAdded: false });
  });

  it("--device: device_code with the link and code, never the device id", async () => {
    const code = await loginCommand(["chatgpt", "--device", "--json"], {
      ...base(),
      requestDevice: async () => ({
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "WXYZ-1234",
        deviceAuthId: "opaque-device-id",
        intervalMs: 5_000,
      }),
      completeDevice: async () => TOKENS,
    });
    expect(code).toBe(0);
    expect(events()[0]).toEqual({
      type: "device_code",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "WXYZ-1234",
      expiresInMinutes: 15,
    });
    expect(out).not.toContain("opaque-device-id");
    expect(events().at(-1)).toMatchObject({ type: "signed_in", providerId: "chatgpt-sub" });
  });

  it.each([
    ["cancelled", new OAuthFlowError("cancelled"), { reason: "cancelled", code: "cancelled", message: "Sign-in cancelled." }],
    ["timeout", new OAuthFlowError("callback_timeout"), { reason: "timeout", code: "callback_timeout" }],
    ["expired code", new OAuthFlowError("device_code_expired"), { reason: "timeout", code: "device_code_expired" }],
    ["no account", new ChatgptNoAccountError(), { reason: "no_account" }],
    ["busy ports", new OAuthFlowError("callback_port_unavailable"), { reason: "failed", code: "callback_port_unavailable" }],
    ["anything else", new Error("secret server body"), { reason: "failed", message: "Sign-in failed." }],
  ])("error line for %s, exit 1, nothing stored", async (_name, err, expected) => {
    const code = await loginCommand(["chatgpt", "--no-browser", "--json"], {
      ...base(),
      startBrowser: async () => browser(Promise.reject(err)),
    });
    expect(code).toBe(1);
    const lines = events();
    expect(lines.at(-1)).toMatchObject({ type: "error", ...expected });
    expect(lines.some((l) => l.type === "signed_in")).toBe(false);
    expect(out).not.toContain("secret server body");
    await expect(store.load()).resolves.toBeNull();
  });

  it("never asks y/n on stdout; the activation sentence becomes a notice line", async () => {
    const ask = vi.fn(async () => "y");
    const setActive = vi.fn();
    await loginCommand(["chatgpt", "--no-browser", "--json"], { ...base(), activation: () => "has-others", ask, setActive });
    expect(ask).not.toHaveBeenCalled();
    expect(setActive).not.toHaveBeenCalled();
    expect(events()).toContainEqual({ type: "notice", message: 'To use it, pick "chatgpt-sub" in the Providers panel.' });
  });

  it("an unknown option is a JSON usage error with exit 2", async () => {
    expect(await loginCommand(["chatgpt", "--nope", "--json"], base())).toBe(2);
    expect(events()).toEqual([{ type: "error", reason: "failed", code: "usage", message: 'unknown option "--nope"' }]);
  });
});
