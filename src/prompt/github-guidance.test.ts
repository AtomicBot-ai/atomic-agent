import { describe, expect, it } from "vitest";

import { COMPOSIO_GUIDANCE, COMPOSIO_SEARCH_TOOL } from "./composio-guidance.js";
import {
  GITHUB_GUIDANCE,
  GITHUB_MARKER_TOOL,
  isGithubActive,
} from "./github-guidance.js";
import { buildStablePrefix, type ToolDescriptor } from "./stable-prefix.js";
import type { CapabilitiesSummary } from "./capabilities.js";

function descriptor(name: string): ToolDescriptor {
  return { name, summary: `${name} summary`, argsSchema: "{}" };
}

const CAPS: CapabilitiesSummary = {
  platform: "linux",
} as unknown as CapabilitiesSummary;

function prefixWith(descriptors: readonly ToolDescriptor[]): string {
  return buildStablePrefix({
    toolDescriptors: descriptors,
    capabilities: CAPS,
    skillCatalog: [],
  });
}

describe("isGithubActive", () => {
  it("keys off the github.whoami descriptor being in the catalog", () => {
    expect(isGithubActive([descriptor(GITHUB_MARKER_TOOL)])).toBe(true);
    expect(isGithubActive([descriptor("os.git.push")])).toBe(false);
    expect(isGithubActive([])).toBe(false);
  });
});

describe("the ### integrations prefix section", () => {
  it("is byte-identical to before when GitHub is not connected", () => {
    const prefix = prefixWith([descriptor("os.fs.read"), descriptor("os.git.push")]);
    expect(prefix).not.toContain("### integrations");
    expect(prefix).not.toContain("GitHub is connected");
  });

  it("carries the GitHub guidance once the hub holds a token", () => {
    const prefix = prefixWith([descriptor("os.fs.read"), descriptor(GITHUB_MARKER_TOOL)]);
    expect(prefix).toContain("### integrations");
    expect(prefix).toContain(GITHUB_GUIDANCE);
    expect(prefix).not.toContain(COMPOSIO_GUIDANCE);
  });

  it("stacks Composio and GitHub under one heading", () => {
    const prefix = prefixWith([
      descriptor(COMPOSIO_SEARCH_TOOL),
      descriptor(GITHUB_MARKER_TOOL),
    ]);
    expect(prefix.split("### integrations")).toHaveLength(2);
    expect(prefix.indexOf(COMPOSIO_GUIDANCE)).toBeLessThan(
      prefix.indexOf(GITHUB_GUIDANCE),
    );
  });

  it("names the tools it talks about", () => {
    for (const name of [
      "os.git.push",
      "os.git.commit",
      "github.pr.create",
      "github.issue.create",
    ]) {
      expect(GITHUB_GUIDANCE).toContain(name);
    }
  });
});
