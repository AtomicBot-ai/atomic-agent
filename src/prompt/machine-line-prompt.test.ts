import { describe, expect, it } from "vitest";

import { buildPrompt } from "./build-prompt.js";
import type { BuildPromptInput } from "./build-prompt-types.js";
import { createEmptySessionState } from "../session/session-state.js";
import { formatCapabilities, type CapabilitiesSummary } from "./stable-prefix.js";

/**
 * ATO-1721 / ATO-1706 seam: the `machine:` line reaches the stable prefix
 * of a model served on this machine and no other. The default test config
 * has one text provider, `local-llama`, on a loopback address.
 */

const MACHINE = "16 GB RAM, Intel Core i5-8250U, no GPU, Windows 10";
const CAPS: CapabilitiesSummary = {
  platform: "win32",
  arch: "x64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: true,
  hasNotifications: true,
  machine: MACHINE,
};

function withoutMachine(): CapabilitiesSummary {
  const caps: CapabilitiesSummary = { ...CAPS };
  delete caps.machine;
  return caps;
}

function input(overrides: Partial<BuildPromptInput> = {}): BuildPromptInput {
  return {
    session: createEmptySessionState({ id: "machine-line", workingDir: "/work" }),
    toolDescriptors: [],
    capabilities: CAPS,
    skillCatalog: [],
    ...overrides,
  };
}

describe("formatCapabilities machine line", () => {
  it("prints the line after the platform when present", () => {
    const lines = formatCapabilities(CAPS).split("\n");
    expect(lines[0]).toBe("platform: win32/x64");
    expect(lines[1]).toBe(`machine: ${MACHINE}`);
  });

  it("prints nothing when the probe failed", () => {
    expect(formatCapabilities(withoutMachine())).not.toContain("machine:");
    expect(formatCapabilities({ ...CAPS, machine: null })).not.toContain("machine:");
  });
});

describe("buildPrompt machine line", () => {
  it("is in the prefix for the local provider", () => {
    expect(buildPrompt(input()).stablePrefix).toContain(`machine: ${MACHINE}`);
    const local = { mode: "local" as const, source: "provider" as const, providerId: "local-llama", modelId: "m" };
    expect(buildPrompt(input({ modelMode: local })).stablePrefix).toContain(`machine: ${MACHINE}`);
  });

  it("is absent for a provider not on this machine", () => {
    const cloud = { mode: "cloud" as const, source: "provider" as const, providerId: "openrouter", modelId: "m" };
    const prompt = buildPrompt(input({ modelMode: cloud }));
    expect(prompt.stablePrefix).not.toContain("machine:");
    expect(prompt.text).not.toContain(MACHINE);
    // Mode is policy, not location: a remote provider in local mode is still remote.
    const remoteLocalMode = { ...cloud, mode: "local" as const };
    expect(buildPrompt(input({ modelMode: remoteLocalMode })).stablePrefix).not.toContain("machine:");
  });

  it("is absent when the probe failed", () => {
    expect(buildPrompt(input({ capabilities: withoutMachine() })).stablePrefix).not.toContain("machine:");
  });

  it("keeps the stable prefix byte-identical across two builds", () => {
    expect(buildPrompt(input()).stablePrefix).toBe(buildPrompt(input()).stablePrefix);
  });
});
