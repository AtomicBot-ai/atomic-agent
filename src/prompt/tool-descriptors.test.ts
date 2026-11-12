import { describe, it, expect } from "vitest";

import {
  DEFAULT_TOOL_DESCRIPTORS,
  getToolDescriptorByName,
} from "./tool-descriptors.js";

/**
 * ATO-1296: `os.git.push`, `os.git.commit` and `os.git.checkout` each
 * had two descriptors with different args. The prompt showed both, and
 * the by-name lookup (last-wins) served the second, so `tool.view` and
 * error auto-expansion showed `os.git.commit` without `paths` although
 * the tool accepts it.
 */
describe("DEFAULT_TOOL_DESCRIPTORS", () => {
  it("has exactly one descriptor per tool name", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const descriptor of DEFAULT_TOOL_DESCRIPTORS) {
      if (seen.has(descriptor.name)) duplicates.push(descriptor.name);
      seen.add(descriptor.name);
    }
    expect(duplicates).toEqual([]);
  });

  it("resolves each name to the one descriptor the prompt renders", () => {
    for (const descriptor of DEFAULT_TOOL_DESCRIPTORS) {
      expect(getToolDescriptorByName(descriptor.name), descriptor.name).toBe(descriptor);
    }
  });

  it("describes os.git.commit with `paths`, in the text and the JSON Schema", () => {
    const commit = getToolDescriptorByName("os.git.commit")!;
    expect(commit.argsSchema).toContain("paths?: string[]");
    const properties = commit.argsJsonSchema?.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(["all", "message", "paths", "repo"]);
    expect(commit.argsJsonSchema?.required).toEqual(["message"]);
  });

  it("keeps the git write tools' text args in step with their JSON Schema", () => {
    for (const name of ["os.git.checkout", "os.git.commit", "os.git.push"]) {
      const descriptor = getToolDescriptorByName(name)!;
      const properties = descriptor.argsJsonSchema?.properties as Record<string, unknown>;
      const textKeys = [...descriptor.argsSchema.matchAll(/(\w+)\??:/g)].map((m) => m[1]);
      expect(textKeys.sort(), name).toEqual(Object.keys(properties).sort());
    }
    expect(getToolDescriptorByName("os.git.push")!.argsSchema).toContain("setUpstream?: boolean");
  });
});
