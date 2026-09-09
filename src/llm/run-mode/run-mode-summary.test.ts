import { describe, expect, it } from "vitest";

import type { ResolvedRunMode } from "./resolve-run-mode.js";
import { describeRunMode, runModeLabel } from "./run-mode-summary.js";

const base: ResolvedRunMode = {
  stored: "fusion",
  effective: "fusion",
  orchestratorProviderId: "openrouter",
  orchestratorModel: "anthropic/claude-sonnet-4.5",
  workerProviderId: "local-llama",
  workerModel: "qwen-3.5-4b",
  workers: 3,
  workerMaxSteps: 40,
  workerTimeoutMs: 600_000,
  primaryProviderId: "openrouter",
  degraded: null,
};

describe("describeRunMode", () => {
  it("describes an effective fusion with both legs and the worker count", () => {
    expect(describeRunMode(base)).toBe(
      "Fusion — orchestrator openrouter (anthropic/claude-sonnet-4.5), 3 workers on local-llama (qwen-3.5-4b)",
    );
    expect(describeRunMode({ ...base, workers: 1, workerModel: null })).toContain(
      "1 worker on local-llama",
    );
  });

  it("describes a plain mode by its active provider", () => {
    expect(
      describeRunMode({ ...base, stored: null, effective: "local", primaryProviderId: "local-llama" }),
    ).toBe("Local — active provider local-llama");
  });

  it("says when the stored and the effective mode disagree", () => {
    const line = describeRunMode({ ...base, effective: "cloud", primaryProviderId: "groq" });
    expect(line).toContain("Cloud — active provider groq");
    expect(line).toContain("stored fusion, effective cloud");
    expect(line).toContain("orchestrator provider is not the active one");
  });

  it("appends the degradation sentence when there is one", () => {
    const line = describeRunMode({
      ...base,
      effective: "local",
      orchestratorProviderId: null,
      primaryProviderId: "local-llama",
      degraded: { reason: "no-cloud-provider", requested: "fusion" },
    });
    expect(line).toContain("Local — active provider local-llama");
    expect(line).toContain("Fusion needs a cloud orchestrator");
    expect(line).not.toContain("stored fusion, effective");
  });

  it("capitalises the mode words", () => {
    expect(["local", "cloud", "fusion"].map(runModeLabel)).toEqual(["Local", "Cloud", "Fusion"]);
  });
});
