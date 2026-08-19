import { describe, expect, it } from "vitest";

import {
  SUBSCRIPTION_CLI_KIND,
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
      expect(usesExternalCliAuth({ kind, subscriptionCli: { cli: "claude" } })).toBe(
        false,
      );
    }
  });
});
