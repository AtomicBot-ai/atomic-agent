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
});
