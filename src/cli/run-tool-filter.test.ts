import { describe, expect, it } from "vitest";

import { buildRunToolFilter, unmatchedToolPatterns } from "./run-tool-filter.js";

/** ATO-2440: `run --allowed-tools` / `--disallowed-tools` as a turn's toolFilter. */
describe("run tool filter", () => {
  it("adds no filter when neither list is given", () => {
    expect(buildRunToolFilter([], [])).toEqual({ patterns: [] });
  });

  it("keeps only allowed tools, but never hides reply or finish", () => {
    const built = buildRunToolFilter(["os.fs.*", "Bash"], []);
    if ("error" in built) throw new Error(built.error);
    const filter = built.filter!;
    expect(filter("os.fs.read")).toBe(true);
    expect(filter("os.shell.run")).toBe(true);
    expect(filter("browser.open")).toBe(false);
    expect(filter("reply")).toBe(true);
    expect(filter("finish")).toBe(true);
  });

  it("hides disallowed tools, even inside an allowed prefix", () => {
    const built = buildRunToolFilter(["os.fs.*"], ["os.fs.write", "mcp__github"]);
    if ("error" in built) throw new Error(built.error);
    const filter = built.filter!;
    expect(filter("os.fs.write")).toBe(false);
    expect(filter("os.fs.read")).toBe(true);
    const denyOnly = buildRunToolFilter([], ["mcp__github", "reply"]);
    if ("error" in denyOnly) throw new Error(denyOnly.error);
    expect(denyOnly.filter!("mcp.github.create_issue")).toBe(false);
    expect(denyOnly.filter!("browser.open")).toBe(true);
    // A deny list cannot take away the answer.
    expect(denyOnly.filter!("reply")).toBe(true);
  });

  it("refuses an entry it cannot read", () => {
    expect(buildRunToolFilter([], ["Not-A-Tool"])).toEqual({
      error: expect.stringContaining("unknown tool name: Not-A-Tool"),
    });
  });

  it("names the patterns that match no tool", () => {
    expect(unmatchedToolPatterns(["os.fs.*", "mcp.jira.*", "reply"], ["os.fs.read", "reply"])).toEqual([
      "mcp.jira.*",
    ]);
  });
});
