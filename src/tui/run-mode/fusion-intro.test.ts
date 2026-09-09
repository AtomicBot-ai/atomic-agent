import { describe, expect, it } from "vitest";

import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { describeFusionIntro } from "./fusion-intro.js";

const rm: ResolvedRunMode = {
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

describe("describeFusionIntro", () => {
  it("names both legs it actually resolved, not the abstraction", () => {
    const text = describeFusionIntro(rm);
    expect(text).toContain("anthropic/claude-sonnet-4.5");
    expect(text).toContain("3 × qwen-3.5-4b");
  });

  it("says how to pick the two models and how to change the worker count", () => {
    const text = describeFusionIntro(rm);
    expect(text).toContain("ctrl+r");
    expect(text).toContain("Workers");
    expect(text).toContain("/runmode workers N");
    expect(text).toMatch(/restart the local daemon/);
  });

  it("says what a worker is and what it cannot do", () => {
    const text = describeFusionIntro(rm);
    expect(text).toMatch(/in parallel/);
    expect(text).toMatch(/cannot reach you or ask for approval/);
  });

  it("carries no markdown — the system bubble renders plain text", () => {
    const text = describeFusionIntro(rm);
    expect(text).not.toContain("**");
    // The bubble already prefixes its own `·`; a second one reads as a typo.
    expect(text.split("\n").some((line) => line.startsWith("·"))).toBe(false);
  });

  it("falls back to provider names when no model is pinned", () => {
    const text = describeFusionIntro({
      ...rm,
      orchestratorModel: null,
      workerModel: null,
    });
    expect(text).toContain("openrouter");
    expect(text).toContain("the local model");
  });
});
