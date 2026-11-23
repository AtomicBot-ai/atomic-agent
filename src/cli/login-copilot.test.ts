import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OAuthFlowError,
  createFileTokenStore,
  subscriptionTokenPath,
  type DeviceAuthorization,
  type FileTokenStore,
} from "../llm/provider/subscription-oauth/index.js";
import { loginCommand, logoutCommand } from "./login-command.js";
import { describeCopilotLoginFailure } from "./login-copilot.js";

const GH_TOKEN = "gho_secret_github_token_123";
const CODE: DeviceAuthorization = {
  deviceCode: "dc_secret_device_code",
  userCode: "WXYZ-9876",
  verificationUri: "https://github.com/login/device",
  expiresAt: 15 * 60_000,
  intervalMs: 5_000,
};

describe("atomic-agent login / logout copilot (ATO-462)", () => {
  let dir: string;
  let store: FileTokenStore;
  let out: string;
  const write = (t: string) => {
    out += t;
  };
  const ensureProviderEntry = vi.fn((_model: string) => ({ id: "copilot-sub", added: true }));
  const setActive = vi.fn((_id: string) => {});

  const deps = (extra: Record<string, unknown> = {}) => ({
    write,
    now: () => 0,
    setActive,
    activation: () => "already-active" as const,
    copilot: {
      store,
      requestDevice: async () => CODE,
      completeDevice: async () => ({ accessToken: GH_TOKEN, tokenType: "bearer" }),
      ensureProviderEntry,
    },
    ...extra,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "login-copilot-"));
    store = createFileTokenStore({ path: subscriptionTokenPath(dir, "copilot") });
    out = "";
    ensureProviderEntry.mockClear();
    setActive.mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("help names login copilot", async () => {
    expect(await loginCommand(["--help"], { write })).toBe(0);
    expect(out).toContain("login copilot");
  });

  it("prints the github.com link and code, stores the GitHub token, adds the provider, prints no token", async () => {
    expect(await loginCommand(["copilot"], deps())).toBe(0);
    expect(out).toContain("https://github.com/login/device");
    expect(out).toContain("WXYZ-9876");
    expect(out).toContain("expires in 15 minutes");
    expect(out).toMatch(/experimental/i);
    expect(out).toContain('Added provider "copilot-sub"');
    expect(out).not.toContain(GH_TOKEN);
    expect(out).not.toContain("dc_secret_device_code");
    expect((await store.load())?.accessToken).toBe(GH_TOKEN);
    expect(ensureProviderEntry).toHaveBeenCalledWith("gpt-4.1");
  });

  it("asks 'Use GitHub Copilot now?' when other providers exist", async () => {
    const ask = vi.fn(async () => "y");
    expect(await loginCommand(["copilot"], deps({ activation: () => "has-others" as const, ask }))).toBe(0);
    expect(ask).toHaveBeenCalledWith("Use GitHub Copilot now? [y/N] ");
    expect(setActive).toHaveBeenCalledWith("copilot-sub");
  });

  it("refuses options it does not know", async () => {
    expect(await loginCommand(["copilot", "--device"], deps())).toBe(2);
  });

  it("a failed sign-in exits 1 with one sentence and stores nothing", async () => {
    const failing = deps();
    failing.copilot.completeDevice = async () => {
      throw new OAuthFlowError("device_code_expired");
    };
    expect(await loginCommand(["copilot"], failing)).toBe(1);
    expect(out).toContain("The code expired");
    expect(await store.load()).toBeNull();
    expect(ensureProviderEntry).not.toHaveBeenCalled();
  });

  it("status copilot says signed in or not, without the token", async () => {
    expect(await loginCommand(["status", "copilot"], deps())).toBe(1);
    expect(out).toContain("not signed in");
    await store.save({ accessToken: GH_TOKEN });
    out = "";
    expect(await loginCommand(["status", "copilot", "--json"], deps())).toBe(0);
    const report = JSON.parse(out) as Record<string, unknown>;
    expect(report).toMatchObject({ service: "copilot", experimental: true, signedIn: true });
    expect(out).not.toContain(GH_TOKEN);
  });

  it("logout copilot deletes the stored sign-in, and is fine when signed out", async () => {
    await store.save({ accessToken: GH_TOKEN });
    expect(await logoutCommand(["copilot"], deps())).toBe(0);
    expect(out).toContain("Signed out of GitHub Copilot");
    expect(await store.load()).toBeNull();
    out = "";
    expect(await logoutCommand(["copilot"], deps())).toBe(0);
    expect(out).toContain("nothing to delete");
  });

  it("words each failure without GitHub's text", () => {
    expect(describeCopilotLoginFailure(new OAuthFlowError("authorization_denied"))).toMatch(/not approved/);
    expect(describeCopilotLoginFailure(new OAuthFlowError("network_error"))).toMatch(/github\.com/);
    expect(describeCopilotLoginFailure(new Error(`boom ${GH_TOKEN}`))).toBe("Sign-in failed.");
  });
});
