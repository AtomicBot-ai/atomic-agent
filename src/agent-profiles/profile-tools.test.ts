import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_PROFILES } from "./builtin-profiles.js";
import { compileToolAllowlist } from "./profile-tools.js";

describe("compileToolAllowlist (ATO-566)", () => {
  it("no list is no allowlist", () => {
    expect(compileToolAllowlist(undefined).allows).toBeUndefined();
    expect(compileToolAllowlist([]).allows).toBeUndefined();
  });

  it("matches our names exactly and prefixes with .*, and always keeps reply and discovery", () => {
    const { allows, unknown } = compileToolAllowlist(["os.fs.read", "verify.*"]);
    expect(unknown).toEqual([]);
    expect(allows?.("os.fs.read")).toBe(true);
    expect(allows?.("os.fs.read_document")).toBe(false);
    expect(allows?.("verify.run")).toBe(true);
    expect(allows?.("verifyx")).toBe(false);
    expect(allows?.("os.fs.write")).toBe(false);
    expect(allows?.("reply")).toBe(true);
    expect(allows?.("tool.view")).toBe(true);
  });

  it("maps Claude Code tool names and mcp__ names", () => {
    const { allows, patterns } = compileToolAllowlist(["Read", "Grep", "Bash", "mcp__github__list_issues", "mcp__slack"]);
    expect(patterns).toEqual(["os.fs.read", "os.fs.read_document", "os.fs.grep", "os.shell.run", "mcp.github.list_issues", "mcp.slack.*"]);
    expect(allows?.("os.shell.run")).toBe(true);
    expect(allows?.("mcp.slack.chat_post_message")).toBe(true);
    expect(allows?.("mcp.github.create_issue")).toBe(false);
  });

  it("reports unknown entries; a list of only unknown entries is no allowlist", () => {
    const some = compileToolAllowlist(["Read", "Teleport"]);
    expect(some.unknown).toEqual(["Teleport"]);
    expect(some.allows).toBeDefined();
    const none = compileToolAllowlist(["Teleport", "Task"]);
    expect(none.allows).toBeUndefined();
    expect(none.unknown).toEqual(["Teleport", "Task"]);
  });

  it("the built-in profiles compile cleanly and none of them can write or run a shell", () => {
    for (const profile of BUILTIN_AGENT_PROFILES) {
      const { allows, unknown } = compileToolAllowlist(profile.tools);
      expect(unknown, profile.name).toEqual([]);
      expect(allows, profile.name).toBeDefined();
      for (const tool of ["os.fs.write", "os.fs.edit", "os.fs.patch", "os.shell.run", "os.git.commit", "os.git.push", "browser.click", "browser.type", "os.email.send"]) {
        expect(allows!(tool), `${profile.name} ${tool}`).toBe(false);
      }
      expect(allows!("os.fs.read"), profile.name).toBe(true);
    }
  });
});
