import { describe, expect, it } from "vitest";
import type { ToolDescriptor } from "../../prompt/stable-prefix.js";
import {
  applyToolSearch,
  CORE_TOOL_NAMES,
  DEFERRED_SUMMARY_CHARS,
  deferredToolNames,
  TOOL_SEARCH_MAX_TOOLS,
  TOOL_SEARCH_SMALL_WINDOW,
  toolSearchActive,
} from "./tool-search-policy.js";

const d = (name: string, summary = "does a thing", tier?: "rare"): ToolDescriptor => ({
  name, summary, argsSchema: "{ x: string }", ...(tier ? { tier } : {}),
});

describe("toolSearchActive", () => {
  it("on/off are absolute; auto turns on for a small window or a big catalog", () => {
    expect(toolSearchActive("on", 1, 1_000_000)).toBe(true);
    expect(toolSearchActive("off", 1_000, 1_000)).toBe(false);
    expect(toolSearchActive("auto", 50, TOOL_SEARCH_SMALL_WINDOW)).toBe(true);
    expect(toolSearchActive("auto", 50, TOOL_SEARCH_SMALL_WINDOW + 1)).toBe(false);
    expect(toolSearchActive("auto", TOOL_SEARCH_MAX_TOOLS + 1, 1_000_000)).toBe(true);
    expect(toolSearchActive("auto", TOOL_SEARCH_MAX_TOOLS, null)).toBe(false);
    expect(toolSearchActive("auto", 50, undefined)).toBe(false);
    expect(toolSearchActive("auto", 50, 0)).toBe(false);
  });
});

describe("applyToolSearch", () => {
  const list = [
    d("os.fs.read"),
    d("tool.search"),
    d("reply"),
    d("os.git.show", "Show a commit", "rare"),
    d("mcp.slack.post", "[mcp:slack] " + "Post a message to a channel. ".repeat(10)),
  ];

  it("inactive: unchanged except tool.search, which has nothing to find", () => {
    const out = applyToolSearch(list, false);
    expect(out.map((t) => t.name)).toEqual(["os.fs.read", "reply", "os.git.show", "mcp.slack.post"]);
    expect(out[0]).toBe(list[0]);
    const without = list.filter((t) => t.name !== "tool.search");
    expect(applyToolSearch(without, false)).toBe(without);
  });

  it("active: core untouched, the rest rare with a short summary", () => {
    const out = applyToolSearch(list, true);
    expect(out[0]).toBe(list[0]);
    expect(out[1]).toBe(list[1]);
    expect(out[3]).toBe(list[3]);
    const slack = out[4]!;
    expect(slack.tier).toBe("rare");
    expect(slack.summary.length).toBeLessThanOrEqual(DEFERRED_SUMMARY_CHARS);
    expect(slack.summary.endsWith("…")).toBe(true);
    expect(slack.argsSchema).toBe(list[4]!.argsSchema);
    expect(deferredToolNames(list, out)).toEqual(new Set(["mcp.slack.post"]));
  });

  it("keeps the terminals and the file/shell basics in the core set", () => {
    for (const name of ["reply", "finish", "tool.search", "os.shell.run", "os.fs.read", "os.fs.edit", "os.fs.write"]) {
      expect(CORE_TOOL_NAMES.has(name), name).toBe(true);
    }
    expect(CORE_TOOL_NAMES.has("os.git.commit")).toBe(false);
  });
});
