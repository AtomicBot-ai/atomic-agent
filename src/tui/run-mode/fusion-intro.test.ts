import { describe, expect, it } from "vitest";

import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { FUSION_MARK, describeFusionIntro } from "./fusion-intro.js";

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
  it("opens with the mark, then the sentence", () => {
    const text = describeFusionIntro(rm);
    expect(text.startsWith(FUSION_MARK)).toBe(true);
    expect(text).toContain("Fusion splits the work between two models");
  });

  it("keeps the mark small and rectangular so a short pane still fits it", () => {
    const lines = FUSION_MARK.split("\n");
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(30);
  });

  it("draws a tree: the one that plans on top, the ones that do below", () => {
    // The shape is the explanation. The old mark put two nodes side by
    // side and labelled them `cloud` and `local`, which stopped being
    // true the day either seat could hold either kind.
    const lines = FUSION_MARK.split("\n");
    expect(lines[0]).toContain("orchestrator");
    expect(lines[0]).toContain("\u25cf");
    expect(lines[3]).toContain("workers");
    expect(lines[3]).toContain("\u25cb");
    expect(FUSION_MARK).not.toContain("cloud");
    expect(FUSION_MARK).not.toContain("local");
  });

  it("draws the mark from glyphs the rest of the chrome already uses", () => {
    // Anything outside this set risks a double-width cell, which would
    // shear the mark on the terminals the TUI supports.
    expect(FUSION_MARK).toMatch(/^[\s\u25cf\u25cb\u2502\u250c\u2510\u253c\u2500a-z]+$/);
  });

  it("names both legs it actually resolved, not the abstraction", () => {
    const text = describeFusionIntro(rm);
    expect(text).toContain("anthropic/claude-sonnet-4.5");
    expect(text).toContain("qwen-3.5-4b");
  });

  it("states the width as the orchestrator's call, not a setting", () => {
    // The count left the composer with v63: the machine sizes the pool
    // and the orchestrator sizes each fan-out inside it. An intro that
    // told the operator to go and set a number would be describing a
    // control that is not there.
    const text = describeFusionIntro(rm);
    expect(text).toMatch(/not a setting/);
    expect(text).toMatch(/sizes each fan-out/);
    expect(text).not.toMatch(/\/runmode workers/);
  });

  it("says either seat takes either kind, and invites the pairing", () => {
    const text = describeFusionIntro(rm);
    expect(text).toMatch(/Either seat takes either kind/);
    expect(text).toMatch(/local model plans while cloud workers execute/);
    expect(text).toMatch(/Two cloud models/);
  });

  it("says what a worker is and what it cannot do", () => {
    const text = describeFusionIntro(rm);
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
    expect(text).toContain("local-llama");
  });
});
