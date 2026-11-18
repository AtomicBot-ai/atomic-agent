import { describe, expect, it } from "vitest";

import { parseLlmProviderEntry } from "./llm-config.js";
import { unknownProviderReason } from "./llm-set-aside-providers.js";
import { defaultProviderModelMode } from "./model-mode.js";
import {
  SUBSCRIPTION_CLI_KIND,
  SUBSCRIPTION_OAUTH_KIND,
  usesExternalCliAuth,
} from "./provider-auth-mode.js";

describe("usesExternalCliAuth", () => {
  it("is true for a subscription-cli entry that names a cli", () => {
    expect(
      usesExternalCliAuth({
        kind: SUBSCRIPTION_CLI_KIND,
        subscriptionCli: { cli: "claude" },
      }),
    ).toBe(true);
    expect(
      usesExternalCliAuth({
        kind: SUBSCRIPTION_CLI_KIND,
        subscriptionCli: { cli: "codex" },
      }),
    ).toBe(true);
  });

  it("is false for the kind without a cli block", () => {
    expect(usesExternalCliAuth({ kind: SUBSCRIPTION_CLI_KIND })).toBe(false);
  });

  it("is false for every key-carrying kind", () => {
    for (const kind of [
      "llama-server",
      "openai-compatible",
      "qwen-openai-compatible",
      "openrouter",
      "aimlapi",
      "gemini",
    ]) {
      expect(usesExternalCliAuth({ kind })).toBe(false);
      // Even a hand-edited config that bolts the block onto another kind
      // must not be treated as CLI-authenticated.
      expect(
        usesExternalCliAuth({ kind, subscriptionCli: { cli: "claude" } }),
      ).toBe(false);
    }
  });
});

describe("subscription-oauth (experimental ChatGPT sign-in, ATO-1453)", () => {
  it("counts as keyless-but-working, like a signed-in CLI", () => {
    expect(usesExternalCliAuth({ kind: SUBSCRIPTION_OAUTH_KIND })).toBe(true);
  });

  it("parses with or without its service block, and names no token", () => {
    const bare = parseLlmProviderEntry({ id: "chatgpt-sub", kind: SUBSCRIPTION_OAUTH_KIND }, "p");
    expect(bare.kind).toBe(SUBSCRIPTION_OAUTH_KIND);
    expect(bare.subscriptionOauth).toBeUndefined();
    const named = parseLlmProviderEntry(
      { id: "chatgpt-sub", kind: SUBSCRIPTION_OAUTH_KIND, subscriptionOauth: { service: "chatgpt" } },
      "p",
    );
    expect(named.subscriptionOauth).toEqual({ service: "chatgpt" });
    expect(named.apiKey).toBeUndefined();
  });

  it("refuses a service it does not know", () => {
    expect(() =>
      parseLlmProviderEntry(
        { id: "x", kind: SUBSCRIPTION_OAUTH_KIND, subscriptionOauth: { service: "claude" } },
        "p",
      ),
    ).toThrow(/subscriptionOauth\.service/);
  });

  it("is billed by the plan, so it is a cloud link", () => {
    expect(defaultProviderModelMode({ kind: SUBSCRIPTION_OAUTH_KIND })).toBe("cloud");
  });
});

describe("a sign-in service from a newer build (ATO-1448)", () => {
  it("is set aside, not a broken file", () => {
    expect(
      unknownProviderReason(
        { id: "x", kind: SUBSCRIPTION_OAUTH_KIND, subscriptionOauth: { service: "future" } },
        new Set([SUBSCRIPTION_OAUTH_KIND]),
        [],
      ),
    ).toMatch(/sign-in service "future"/);
    expect(
      unknownProviderReason(
        { id: "x", kind: SUBSCRIPTION_OAUTH_KIND, subscriptionOauth: { service: "chatgpt" } },
        new Set([SUBSCRIPTION_OAUTH_KIND]),
        [],
      ),
    ).toBeNull();
  });
});
