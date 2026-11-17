import { describe, expect, it } from "vitest";
import {
  MAX_PROFILE_FILE_BYTES,
  MAX_PROFILE_PROMPT_CHARS,
  normaliseProfileName,
  parseAgentProfileFile,
} from "./agent-profile.js";

describe("parseAgentProfileFile (ATO-566)", () => {
  it("reads a Claude Code agent file: name, description, model, comma tools, body", () => {
    const parsed = parseAgentProfileFile(
      "---\nname: Code-Reviewer\ndescription: Reviews code\nmodel: sonnet\ntools: Read, Grep, Glob\ncolor: red\n---\n\nYou review code.\n",
      "file-name",
    );
    expect(parsed).toEqual({
      ok: true,
      profile: {
        name: "code-reviewer",
        description: "Reviews code",
        model: "sonnet",
        tools: ["Read", "Grep", "Glob"],
        prompt: "You review code.",
      },
    });
  });

  it("accepts a YAML list of tools, drops duplicates and blanks, and falls back to the file name", () => {
    const parsed = parseAgentProfileFile("---\ntools:\n  - os.fs.read\n  - os.fs.read\n  - ''\n---\nBody", "Explorer");
    expect(parsed).toMatchObject({ ok: true, profile: { name: "explorer", tools: ["os.fs.read"] } });
  });

  it("treats an empty tools list as no allowlist", () => {
    const parsed = parseAgentProfileFile("---\ntools: []\n---\nBody", "x");
    expect(parsed.ok && parsed.profile.tools).toBe(undefined);
  });

  it("loads a file with no frontmatter as a body named after the file", () => {
    expect(parseAgentProfileFile("Just instructions", "plain")).toEqual({
      ok: true,
      profile: { name: "plain", description: "", prompt: "Just instructions" },
    });
  });

  it("collects every problem of a broken file in one message", () => {
    const parsed = parseAgentProfileFile("---\nname: 'bad name!'\ndescription: 3\nmodel: ''\ntools: 7\n---\n", "x");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("name must be");
    expect(parsed.error).toContain("description must be text");
    expect(parsed.error).toContain("model must be a non-empty string");
    expect(parsed.error).toContain("tools must be a list");
    expect(parsed.error).toContain("body");
  });

  it("refuses unclosed frontmatter, a non-mapping, invalid YAML and oversize files", () => {
    expect(parseAgentProfileFile("---\nname: a\nBody", "a")).toMatchObject({ ok: false, error: expect.stringContaining("not closed") });
    expect(parseAgentProfileFile("---\n- a\n- b\n---\nBody", "a")).toMatchObject({ ok: false, error: expect.stringContaining("mapping") });
    expect(parseAgentProfileFile("---\nname: [unclosed\n---\nBody", "a")).toMatchObject({ ok: false, error: expect.stringContaining("YAML") });
    expect(parseAgentProfileFile("x".repeat(MAX_PROFILE_FILE_BYTES + 1), "a")).toMatchObject({ ok: false, error: expect.stringContaining("KiB") });
    expect(parseAgentProfileFile(`---\nname: a\n---\n${"y".repeat(MAX_PROFILE_PROMPT_CHARS + 1)}`, "a")).toMatchObject({ ok: false });
  });

  it("normalises names to lower case and rejects anything else", () => {
    expect(normaliseProfileName(" Review ")).toBe("review");
    expect(normaliseProfileName("my_agent-2")).toBe("my_agent-2");
    expect(normaliseProfileName("../evil")).toBeNull();
    expect(normaliseProfileName("")).toBeNull();
    expect(normaliseProfileName("a".repeat(65))).toBeNull();
  });
});
