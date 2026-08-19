import { describe, expect, it } from "vitest";

import { parseUserConfigFile, USER_CONFIG_VERSION } from "./config-schema.js";
import { DEFAULT_FUSION_CLOUD_SHARE } from "./llm-run-mode-config.js";

/** Two-provider file (one local leg, one cloud leg) plus a runMode block. */
const withRunMode = (runMode: unknown) => ({
  version: USER_CONFIG_VERSION,
  llm: {
    activeTextProvider: "openrouter",
    activeEmbeddingProvider: "local-llama",
    toolTransport: "auto",
    providers: [
      { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
      { id: "openrouter", kind: "openrouter", defaultChatModel: "openai/gpt-4o-mini" },
    ],
    runMode,
  },
});

describe("llm-run-mode-config", () => {
  it("round-trips a full runMode block", () => {
    const parsed = parseUserConfigFile(
      withRunMode({
        mode: "fusion",
        localProvider: "local-llama",
        cloudProvider: "openrouter",
        fusion: { cloudShare: 65, subRunners: "follow" },
      }),
    );
    expect(parsed.llm?.runMode).toEqual({
      mode: "fusion",
      localProvider: "local-llama",
      cloudProvider: "openrouter",
      fusion: { cloudShare: 65, subRunners: "follow" },
    });
  });

  it("omits runMode entirely when not configured", () => {
    const parsed = parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      llm: {
        activeTextProvider: "local-llama",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
        ],
      },
    });
    expect(parsed.llm?.runMode).toBeUndefined();
  });

  it("accepts a bare mode and leaves the dial to its default", () => {
    const parsed = parseUserConfigFile(withRunMode({ mode: "local" }));
    expect(parsed.llm?.runMode).toEqual({ mode: "local" });
    // The default is applied by `resolveRunMode`, never written into the
    // file — an absent dial must stay absent so the default can move.
    expect(parsed.llm?.runMode?.fusion).toBeUndefined();
    expect(DEFAULT_FUSION_CLOUD_SHARE).toBe(40);
  });

  it("rejects an unknown mode", () => {
    expect(() => parseUserConfigFile(withRunMode({ mode: "hybrid" }))).toThrow(
      /llm\.runMode\.mode/,
    );
  });

  it("rejects a pinned leg that names an unconfigured provider", () => {
    expect(() =>
      parseUserConfigFile(withRunMode({ cloudProvider: "anthropic" })),
    ).toThrow(/llm\.runMode\.cloudProvider/);
    expect(() =>
      parseUserConfigFile(withRunMode({ localProvider: "ollama" })),
    ).toThrow(/llm\.runMode\.localProvider/);
  });

  it("accepts the inclusive cloudShare bounds", () => {
    for (const cloudShare of [0, 100]) {
      const parsed = parseUserConfigFile(withRunMode({ fusion: { cloudShare } }));
      expect(parsed.llm?.runMode?.fusion?.cloudShare).toBe(cloudShare);
    }
  });

  it("rejects a cloudShare outside 0-100 or non-integer", () => {
    for (const bad of [-1, 101, 42.5, "40", null]) {
      expect(() =>
        parseUserConfigFile(withRunMode({ fusion: { cloudShare: bad } })),
      ).toThrow(/llm\.runMode\.fusion\.cloudShare/);
    }
  });

  it("rejects an unknown subRunners target", () => {
    expect(() =>
      parseUserConfigFile(withRunMode({ fusion: { subRunners: "remote" } })),
    ).toThrow(/llm\.runMode\.fusion\.subRunners/);
  });

  it("rejects a non-object runMode or fusion block", () => {
    expect(() => parseUserConfigFile(withRunMode("fusion"))).toThrow(
      /llm\.runMode/,
    );
    expect(() => parseUserConfigFile(withRunMode({ fusion: [] }))).toThrow(
      /llm\.runMode\.fusion/,
    );
  });
});
