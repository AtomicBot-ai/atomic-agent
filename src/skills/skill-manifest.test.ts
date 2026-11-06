import { describe, it, expect } from "vitest";
import { parseSkillFile, SkillManifestError } from "./skill-manifest.js";

describe("parseSkillFile", () => {
  it("parses a well-formed SKILL.md", () => {
    const content = [
      "---",
      "name: check-gmail-inbox",
      'description: "Check Gmail inbox"',
      "version: 0.1.0",
      "requires_tools: [browser.navigate, browser.read_aria]",
      "requires_scripts: [fetch.sh]",
      "dangerous: true",
      "---",
      "",
      "# Playbook body",
      "",
      "1. Navigate to https://mail.google.com",
    ].join("\n");
    const result = parseSkillFile(content);
    expect(result.manifest).toEqual({
      name: "check-gmail-inbox",
      description: "Check Gmail inbox",
      version: "0.1.0",
      requiresTools: ["browser.navigate", "browser.read_aria"],
      requiresScripts: ["fetch.sh"],
      dangerous: true,
    });
    expect(result.body.startsWith("# Playbook body")).toBe(true);
  });

  it("defaults optional fields", () => {
    const content = [
      "---",
      "name: minimal",
      'description: "Minimum viable skill"',
      "version: 0.0.1",
      "---",
      "body",
    ].join("\n");
    const result = parseSkillFile(content);
    expect(result.manifest.requiresTools).toEqual([]);
    expect(result.manifest.requiresScripts).toEqual([]);
    expect(result.manifest.dangerous).toBe(false);
  });

  it("defaults version to 0.0.0 when the frontmatter omits it", () => {
    // Mirrors the community SKILL.md shape (anthropics/skills,
    // openai/skills): name + description only, no version field.
    const content = [
      "---",
      "name: algorithmic-art",
      'description: "Creating algorithmic art"',
      "license: see LICENSE.txt",
      "---",
      "body",
    ].join("\n");
    const result = parseSkillFile(content);
    expect(result.manifest.name).toBe("algorithmic-art");
    expect(result.manifest.version).toBe("0.0.0");
  });

  it("rejects missing frontmatter", () => {
    expect(() => parseSkillFile("no frontmatter here")).toThrow(
      SkillManifestError,
    );
  });

  it("rejects invalid name", () => {
    const content = [
      "---",
      "name: Bad Name",
      'description: "x"',
      "version: 1",
      "---",
    ].join("\n");
    expect(() => parseSkillFile(content)).toThrow(/kebab-case/);
  });

  it("rejects non-array requires_tools", () => {
    const content = [
      "---",
      "name: skill",
      'description: "x"',
      "version: 1",
      "requires_tools: not-a-list",
      "---",
    ].join("\n");
    expect(() => parseSkillFile(content)).toThrow(/requires_tools/);
  });

  it("omits `platforms` entirely when the frontmatter has no platforms key", () => {
    const content = [
      "---",
      "name: cross-platform",
      'description: "x"',
      "version: 0.1.0",
      "---",
      "body",
    ].join("\n");
    const result = parseSkillFile(content);
    expect("platforms" in result.manifest).toBe(false);
  });

  it("parses a valid platforms allowlist", () => {
    const content = [
      "---",
      "name: mac-only",
      'description: "x"',
      "version: 0.1.0",
      "platforms: [darwin]",
      "---",
      "body",
    ].join("\n");
    const result = parseSkillFile(content);
    expect(result.manifest.platforms).toEqual(["darwin"]);
  });

  it("rejects an unknown platform value", () => {
    const content = [
      "---",
      "name: bad-platform",
      'description: "x"',
      "version: 0.1.0",
      "platforms: [solaris]",
      "---",
    ].join("\n");
    expect(() => parseSkillFile(content)).toThrow(/platforms/);
  });

  it("rejects a non-array platforms value", () => {
    const content = [
      "---",
      "name: bad-platform",
      'description: "x"',
      "version: 1",
      "platforms: darwin",
      "---",
    ].join("\n");
    expect(() => parseSkillFile(content)).toThrow(/platforms/);
  });

  it("keeps Agent Skills spec fields and only warns about limits (ATO-610)", () => {
    const body = Array.from({ length: 501 }, (_, i) => `line ${i}`).join("\n");
    const parsed = parseSkillFile([
      "---",
      "name: spec-skill",
      `description: "${"d".repeat(1025)}"`,
      "license: Apache-2.0",
      "compatibility: Needs git",
      "metadata:",
      "  author: someone",
      "  version: 2",
      "allowed-tools: Bash(git:*) Read",
      "---",
      body,
    ].join("\n"));
    expect(parsed.manifest).toMatchObject({
      license: "Apache-2.0",
      compatibility: "Needs git",
      metadata: { author: "someone", version: "2" },
      allowedTools: ["Bash(git:*)", "Read"],
    });
    expect(parsed.warnings?.join("\n")).toMatch(/description is longer than 1024/);
    expect(parsed.warnings?.join("\n")).toMatch(/501 lines/);
  });

  it("adds no spec keys to a manifest that does not declare them", () => {
    const parsed = parseSkillFile("---\nname: plain\ndescription: d\n---\nbody");
    expect(Object.keys(parsed.manifest).sort()).toEqual(["dangerous", "description", "name", "requiresScripts", "requiresTools", "version"]);
    expect(parsed.warnings).toBeUndefined();
  });
});
