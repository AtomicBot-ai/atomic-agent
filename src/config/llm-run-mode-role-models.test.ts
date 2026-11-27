import { describe, expect, it } from "vitest";

import {
  parseLlmRunModeConfig,
  scrubRunModeProviderPins,
} from "./llm-run-mode-config.js";
import { withoutSetAsideProviderRefs } from "./llm-set-aside-providers.js";

const providers = [
  { id: "local-llama", kind: "llama-server" },
  { id: "openrouter", kind: "openrouter" },
  { id: "or-coder", kind: "openrouter" },
];

describe("llm.runMode.fusion.roleModels: one provider, a model per role", () => {
  it("parses a model per role beside the role's provider", () => {
    expect(
      parseLlmRunModeConfig(
        {
          fusion: {
            roles: { plan: "openrouter", review: "openrouter" },
            roleModels: { plan: "anthropic/claude-opus-5.5", review: "deepseek/deepseek-v4.1" },
          },
        },
        providers,
        "llm.runMode",
      ).fusion,
    ).toEqual({
      roles: { plan: "openrouter", review: "openrouter" },
      roleModels: { plan: "anthropic/claude-opus-5.5", review: "deepseek/deepseek-v4.1" },
    });
  });

  it("keeps an old file without roleModels exactly as before", () => {
    const fusion = parseLlmRunModeConfig(
      { fusion: { roles: { build: "or-coder" } } },
      providers,
      "llm.runMode",
    ).fusion;
    expect(fusion).toEqual({ roles: { build: "or-coder" } });
    expect(fusion).not.toHaveProperty("roleModels");
  });

  it("skips a role a newer build added and names the field for a wrong type", () => {
    expect(
      parseLlmRunModeConfig(
        { fusion: { roleModels: { coder: "x", build: "qwen/qwen3-coder" } } },
        providers,
        "llm.runMode",
      ).fusion?.roleModels,
    ).toEqual({ build: "qwen/qwen3-coder" });
    const parse = (fusion: unknown) => () =>
      parseLlmRunModeConfig({ fusion }, providers, "llm.runMode");
    expect(parse({ roleModels: { build: "" } })).toThrow(/roleModels\.build/);
    expect(parse({ roleModels: { build: 3 } })).toThrow(/roleModels\.build/);
    expect(parse({ roleModels: [] })).toThrow(/roleModels/);
  });

  it("drops a role's model with its provider pin when the provider is removed", () => {
    const scrubbed = scrubRunModeProviderPins(
      {
        mode: "fusion",
        fusion: {
          roles: { plan: "openrouter", build: "or-coder" },
          roleModels: { plan: "anthropic/claude-opus-5.5", build: "qwen/qwen3-coder" },
        },
      },
      "or-coder",
    );
    expect(scrubbed?.fusion?.roles).toEqual({ plan: "openrouter" });
    expect(scrubbed?.fusion?.roleModels).toEqual({ plan: "anthropic/claude-opus-5.5" });
  });

  it("reads a role pinned to a set-aside provider as unpinned, model included", () => {
    const out = withoutSetAsideProviderRefs(
      {
        runMode: {
          fusion: {
            roles: { plan: "openrouter", build: "future-kind" },
            roleModels: { plan: "anthropic/claude-opus-5.5", build: "x" },
          },
        },
      },
      new Set(["future-kind"]),
      null,
    );
    const fusion = (out.runMode as { fusion: Record<string, unknown> }).fusion;
    expect(fusion.roles).toEqual({ plan: "openrouter" });
    expect(fusion.roleModels).toEqual({ plan: "anthropic/claude-opus-5.5" });
  });
});
