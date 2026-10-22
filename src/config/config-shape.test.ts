import { describe, expect, it } from "vitest";

import {
  configBranchKind,
  DICTIONARY_CONFIG_BRANCHES,
  FIXED_CONFIG_BRANCHES,
  knownConfigKeys,
  listDefaultConfigBranches,
} from "./config-shape.js";

describe("config shape map (ATO-764)", () => {
  it("classifies schema blocks as fixed", () => {
    expect(configBranchKind("")).toBe("fixed");
    expect(configBranchKind("memory")).toBe("fixed");
    expect(configBranchKind("tui.onboarding")).toBe("fixed");
    expect(configBranchKind("web.search")).toBe("fixed");
  });

  it("classifies user-keyed maps and lists as dictionaries", () => {
    expect(configBranchKind("mcp.servers")).toBe("dictionary");
    expect(configBranchKind("llm.providers")).toBe("dictionary");
    expect(configBranchKind("webhooks")).toBe("dictionary");
  });

  it("leaves leaves and unknown blocks unclassified", () => {
    expect(configBranchKind("analytics.enabled")).toBeUndefined();
    expect(configBranchKind("localModels.customModels")).toBeUndefined();
    expect(configBranchKind("blockFromTheFuture")).toBeUndefined();
  });

  // The guard: a new object block in the defaults must be classified
  // before it can ship, or an older build's write would either drop
  // its future keys or resurrect entries a caller deleted.
  it("classifies every object node of the defaults exactly once", () => {
    const branches = listDefaultConfigBranches();
    expect(branches.length).toBeGreaterThan(0);
    const unclassified = branches.filter(
      (path) => configBranchKind(path) === undefined,
    );
    expect(unclassified).toEqual([]);
    const both = branches.filter(
      (path) =>
        FIXED_CONFIG_BRANCHES.has(path) && DICTIONARY_CONFIG_BRANCHES.has(path),
    );
    expect(both).toEqual([]);
  });

  it("lists no fixed block the defaults do not have", () => {
    const branches = new Set(["", ...listDefaultConfigBranches()]);
    const stale = [...FIXED_CONFIG_BRANCHES].filter((path) => !branches.has(path));
    expect(stale).toEqual([]);
  });

  it("knows optional and retired keys that are not in the defaults", () => {
    expect(knownConfigKeys("").has("llm")).toBe(true);
    expect(knownConfigKeys("").has("telemetry")).toBe(true);
    expect(knownConfigKeys("agent").has("approvalRequired")).toBe(true);
    expect(knownConfigKeys("discord").has("ownerUserId")).toBe(true);
    expect(knownConfigKeys("memory").has("profile")).toBe(true);
    expect(knownConfigKeys("memory").has("futureKey")).toBe(false);
  });
});
