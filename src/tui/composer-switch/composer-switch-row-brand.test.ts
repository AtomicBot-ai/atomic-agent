import { describe, expect, it } from "vitest";

import { BRANDS } from "../brand/brand-badges.js";
import {
  cloudChatRow,
  cloudProviderRow,
} from "../llm-panel/llm-panel-row-builders.js";
import { providerRow } from "./composer-switch-fixtures.js";
import type { ComposerSwitchRow } from "./composer-switch-row-contracts.js";
import {
  switchRowBrand,
  switchRowsShowBrands,
} from "./composer-switch-row-brand.js";

function row(intent: ComposerSwitchRow["intent"]): ComposerSwitchRow {
  return { id: "r", label: "r", detail: "", active: false, intent };
}

describe("switchRowBrand", () => {
  it("brands a provider row by its provider", () => {
    const provider = providerRow({ id: "openrouter", kind: "openrouter" });
    expect(
      switchRowBrand(row({ kind: "llmRow", row: cloudProviderRow(provider) })),
    ).toBe(BRANDS.openrouter);
  });

  it("brands a model row by its family, not by its provider", () => {
    const provider = providerRow({ id: "openrouter", kind: "openrouter" });
    expect(
      switchRowBrand(
        row({ kind: "llmRow", row: cloudChatRow(provider, "qwen/qwen3.7-max") }),
      ),
    ).toBe(BRANDS.qwen);
    expect(
      switchRowBrand(
        row({ kind: "fusionModel", leg: "worker", modelId: "claude-opus-5" }),
      ),
    ).toBe(BRANDS.claude);
  });

  it("brands a fusion seat by provider id and leaves the local seat blank", () => {
    expect(
      switchRowBrand(
        row({ kind: "fusionLeg", leg: "orchestrator", providerId: "groq" }),
      ),
    ).toBe(BRANDS.groq);
    expect(
      switchRowBrand(
        row({ kind: "fusionLeg", leg: "worker", providerId: "local-llama" }),
      ),
    ).toBeNull();
    expect(
      switchRowBrand(row({ kind: "localEngine", engine: "atomic-core" })),
    ).toBeNull();
  });

  it("gives a custom endpoint a blank, not a monogram", () => {
    const provider = providerRow({ id: "office-box", kind: "openai-compatible" });
    expect(
      switchRowBrand(row({ kind: "llmRow", row: cloudProviderRow(provider) })),
    ).toBeNull();
  });

  it("has no answer for rows that are not a provider or a model", () => {
    expect(switchRowBrand(row({ kind: "addProvider" }))).toBeUndefined();
    expect(
      switchRowBrand(row({ kind: "backend", backend: "cloud" })),
    ).toBeUndefined();
    expect(switchRowBrand(row({ kind: "fusionWorkers", workers: 2 }))).toBeUndefined();
  });
});

describe("switchRowsShowBrands", () => {
  it("reserves the column when any row names a provider or a model", () => {
    expect(
      switchRowsShowBrands([
        row({ kind: "addProvider" }),
        row({ kind: "fusionLeg", leg: "worker", providerId: "local-llama" }),
      ]),
    ).toBe(true);
  });

  it("leaves the route list without one", () => {
    expect(
      switchRowsShowBrands([
        row({ kind: "backend", backend: "cloud" }),
        row({ kind: "backend", backend: "fusion" }),
      ]),
    ).toBe(false);
  });
});
