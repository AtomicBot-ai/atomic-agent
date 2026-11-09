import { describe, expect, it } from "vitest";

import {
  parseLlmRunModeConfig,
  scrubRunModeProviderPins,
} from "./llm-run-mode-config.js";

const providers = [
  { id: "local-llama", kind: "llama-server" },
  { id: "small-llama", kind: "llama-server" },
  { id: "openrouter", kind: "openrouter" },
  { id: "or-coder", kind: "openrouter" },
];

describe("llm.runMode.fusion.roles (ATO-943)", () => {
  it("is absent by default", () => {
    const fusion = parseLlmRunModeConfig({ fusion: {} }, providers, "llm.runMode").fusion;
    expect(fusion?.roles).toBeUndefined();
    expect(fusion?.mixLocalModels).toBeUndefined();
  });

  it("parses role → provider id and mixLocalModels", () => {
    expect(
      parseLlmRunModeConfig(
        {
          fusion: {
            roles: { build: "or-coder", review: "openrouter", utility: "small-llama" },
            mixLocalModels: true,
          },
        },
        providers,
        "llm.runMode",
      ).fusion,
    ).toEqual({
      roles: { build: "or-coder", review: "openrouter", utility: "small-llama" },
      mixLocalModels: true,
    });
  });

  it("skips a role a newer build added", () => {
    expect(
      parseLlmRunModeConfig({ fusion: { roles: { coder: "or-coder", build: "openrouter" } } }, providers, "llm.runMode").fusion?.roles,
    ).toEqual({ build: "openrouter" });
  });

  it("names the field for an unknown provider or a wrong type", () => {
    const parse = (fusion: unknown) => () =>
      parseLlmRunModeConfig({ fusion }, providers, "llm.runMode");
    expect(parse({ roles: { build: "nope" } })).toThrow(/llm\.runMode\.fusion\.roles\.build/);
    expect(parse({ roles: { build: "" } })).toThrow(/roles\.build/);
    expect(parse({ roles: ["or-coder"] })).toThrow(/llm\.runMode\.fusion\.roles/);
    expect(parse({ mixLocalModels: "yes" })).toThrow(/mixLocalModels/);
  });

  it("drops a role pinned to a removed provider so the file stays readable", () => {
    const runMode = {
      mode: "fusion" as const,
      fusion: { roles: { build: "or-coder", utility: "small-llama" } },
    };
    expect(scrubRunModeProviderPins(runMode, "or-coder")).toEqual({
      mode: "fusion",
      fusion: { roles: { utility: "small-llama" } },
    });
    expect(scrubRunModeProviderPins({ fusion: { roles: { build: "or-coder" } } }, "or-coder")).toEqual({
      fusion: {},
    });
    expect(scrubRunModeProviderPins(runMode, "openrouter")).toBe(runMode);
  });
});
