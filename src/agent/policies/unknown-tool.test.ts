import { describe, expect, it } from "vitest";

import { ToolRegistry } from "../../tools/tool-registry.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  UNKNOWN_TOOL_STREAK_LIMIT,
  closestToolNames,
  createUnknownToolStreak,
  editDistance,
  formatUnknownToolMessage,
  refuseUnregisteredTool,
  unregisteredToolNameClass,
} from "./unknown-tool.js";

const REAL = [
  "os.fs.read",
  "os.fs.write",
  "os.fs.grep",
  "os.fs.glob",
  "os.fs.list",
  "os.shell.run",
  "browser.navigate",
  "browser.click",
  "memory.notes.store",
  "reply",
  "finish",
];

describe("closestToolNames", () => {
  it.each([
    ["os.grep", "os.fs.grep"],
    ["os.fs.read_file", "os.fs.read"],
    ["os.shel.run", "os.shell.run"],
    ["os.shell", "os.shell.run"],
    ["os.fs.shell.run", "os.shell.run"],
    ["os.browser.navigate", "browser.navigate"],
    ["write", "os.fs.write"],
  ])("puts the real tool first for %s", (emitted, expected) => {
    expect(closestToolNames(emitted, REAL)[0]).toBe(expected);
  });

  it("names at most three tools", () => {
    expect(closestToolNames("os.fs", REAL).length).toBeLessThanOrEqual(3);
    expect(closestToolNames("os.fs.gre", REAL, 1)).toEqual(["os.fs.grep"]);
  });

  it("suggests nothing for a placeholder or an invented server", () => {
    expect(closestToolNames("foo", REAL)).toEqual([]);
    expect(closestToolNames("function_name", REAL)).toEqual([]);
    expect(closestToolNames("mcp.example.toolkit", REAL)).toEqual([]);
  });

  it("does not match on a shared namespace alone", () => {
    expect(closestToolNames("os.fs.mkdir", REAL)).toEqual([]);
  });

  it("is deterministic and never suggests the emitted name itself", () => {
    const first = closestToolNames("os.fs.gr", REAL);
    expect(closestToolNames("os.fs.gr", [...REAL].reverse())).toEqual(first);
    expect(closestToolNames("reply", REAL)).not.toContain("reply");
  });
});

describe("editDistance", () => {
  it("counts single edits", () => {
    expect(editDistance("os.grep", "os.grep")).toBe(0);
    expect(editDistance("shel", "shell")).toBe(1);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("kitten", "sitting")).toBe(3);
  });
});

describe("unknown tool result", () => {
  it("names the closest tools and says nothing ran", () => {
    const text = formatUnknownToolMessage("os.grep", ["os.fs.grep"]);
    expect(text).toContain("no tool named `os.grep`");
    expect(text).toContain("nothing ran");
    expect(text).toContain("Closest: os.fs.grep.");
  });

  it("clamps a long invented name", () => {
    const text = formatUnknownToolMessage("x".repeat(500), []);
    expect(text.length).toBeLessThan(260);
    expect(text).toContain("do not invent tool names");
  });

  it("refuses only names the registry does not hold, with a bounded class", () => {
    const registry = new ToolRegistry();
    for (const name of ["os.fs.grep", "os.fs.glob", "os.fs.read"]) {
      registry.register({
        name, description: name, readonly: true,
        run: async () => compressToolResult({ tool: name, status: "ok", output: "ok" }),
      });
    }
    expect(refuseUnregisteredTool("os.fs.grep", registry)).toBeNull();
    const refused = refuseUnregisteredTool("os.grep", registry);
    expect(refused).toMatchObject({ tool: "os.grep", status: "error" });
    expect(refused?.details).toMatchObject({ unregisteredTool: true, suggestions: ["os.fs.grep"] });
    const narrowed = refuseUnregisteredTool("os.grep", registry, { names: ["os.fs.read"], reason: "fixture" });
    expect(narrowed?.details?.suggestions).toEqual([]);
    expect(unregisteredToolNameClass("os.grep", ["os.fs.grep"])).toBe("near_miss");
    expect(unregisteredToolNameClass("mcp.none.example", [])).toBe("mcp_like");
    expect(unregisteredToolNameClass("foo", [])).toBe("other");
  });
});

describe("createUnknownToolStreak", () => {
  it("counts unknown-only steps in a row and resets on any other step", () => {
    const streak = createUnknownToolStreak();
    expect(streak.record(true)).toBe(1);
    expect(streak.record(true)).toBe(2);
    expect(streak.record(false)).toBe(0);
    for (let i = 1; i <= UNKNOWN_TOOL_STREAK_LIMIT; i += 1) {
      expect(streak.record(true)).toBe(i);
    }
  });
});
