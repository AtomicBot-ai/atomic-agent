import { describe, expect, it } from "vitest";
import { claudeToolName, matcherMatches } from "./hook-matcher.js";

describe("hook matcher", () => {
  it("maps our tools to Claude names", () => {
    expect(claudeToolName("os.shell.run")).toBe("Bash");
    expect(claudeToolName("os.fs.write")).toBe("Write");
    expect(claudeToolName("os.fs.read")).toBe("Read");
    expect(claudeToolName("mcp.github.create_issue")).toBe("mcp__github__create_issue");
    expect(claudeToolName("mcp.resource.list")).toBeNull();
    expect(claudeToolName("browser.click")).toBeNull();
  });

  it("matches Claude matchers against our tools", () => {
    expect(matcherMatches("Bash", "os.shell.run")).toBe(true);
    expect(matcherMatches("Edit|Write", "os.fs.write")).toBe(true);
    expect(matcherMatches("Edit|Write", "os.fs.edit")).toBe(true);
    expect(matcherMatches("Edit|Write", "os.fs.patch")).toBe(true);
    expect(matcherMatches("Edit|Write", "os.fs.read")).toBe(false);
    expect(matcherMatches("mcp__github__.*", "mcp.github.create_issue")).toBe(true);
    expect(matcherMatches("mcp__github__.*", "mcp.slack.post")).toBe(false);
  });

  it("matches our own names and anchors the pattern", () => {
    expect(matcherMatches("os\\.fs\\..*", "os.fs.write")).toBe(true);
    expect(matcherMatches("os.shell.run", "os.shell.run")).toBe(true);
    expect(matcherMatches("Write", "NotebookWrite")).toBe(false);
  });

  it("treats empty and * as match-all, a broken pattern as plain text", () => {
    expect(matcherMatches("", "anything")).toBe(true);
    expect(matcherMatches("*", "anything")).toBe(true);
    expect(matcherMatches("Bash(", "os.shell.run")).toBe(false);
    expect(matcherMatches("Bash(", "Bash(")).toBe(true);
  });
});
