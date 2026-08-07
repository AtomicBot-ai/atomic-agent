import { describe, expect, it } from "vitest";

import { DEFAULT_TOOL_DESCRIPTORS } from "../../prompt/tool-descriptors.js";
import {
  effectiveToolDescriptors,
  listToolFamilies,
  renderToolsOverview,
  renderToolsSearch,
  searchTools,
  type ToolGateSourceConfig,
} from "./tools-listing.js";

/**
 * Every gate open. Tests pass explicit descriptors / configs so results
 * never depend on the config file of the machine running the suite.
 */
const ALL_ENABLED: ToolGateSourceConfig = {
  browser: { enabled: true },
  web: { search: { enabled: true } },
  vision: { enabled: true },
  memory: {
    profile: { enabled: true },
    notes: { enabled: true },
    lessons: { enabled: true },
    procedures: { enabled: true },
  },
  tasks: { enabled: true, agentToolsEnabled: true },
  mcp: { servers: [{}] },
};

describe("listToolFamilies", () => {
  it("groups tools by namespace and sorts both levels", () => {
    const families = listToolFamilies(DEFAULT_TOOL_DESCRIPTORS);
    const names = families.map((f) => f.family);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    const fs = families.find((f) => f.family === "os.fs");
    expect(fs).toBeDefined();
    expect(fs!.tools).toContain("os.fs.read");
    expect(fs!.tools).toContain("os.fs.write");
    expect(fs!.tools).toEqual([...fs!.tools].sort((a, b) => a.localeCompare(b)));
  });

  it("covers the families users ask about", () => {
    const names = listToolFamilies(DEFAULT_TOOL_DESCRIPTORS).map((f) => f.family);
    for (const family of ["os.fs", "os.shell", "os.web", "browser"]) {
      expect(names).toContain(family);
    }
  });
});

describe("effectiveToolDescriptors", () => {
  it("keeps the full catalog when every gate is open", () => {
    const names = effectiveToolDescriptors(ALL_ENABLED).map((d) => d.name);
    expect(names).toEqual(DEFAULT_TOOL_DESCRIPTORS.map((d) => d.name));
  });

  it("drops browser.* when the browser is disabled in config", () => {
    const names = effectiveToolDescriptors({
      ...ALL_ENABLED,
      browser: { enabled: false },
    }).map((d) => d.name);
    expect(names.some((n) => n.startsWith("browser."))).toBe(false);
    expect(names).toContain("os.fs.read");
  });

  it("drops mcp.* when no MCP servers are configured", () => {
    const names = effectiveToolDescriptors({
      ...ALL_ENABLED,
      mcp: { servers: [] },
    }).map((d) => d.name);
    expect(names.some((n) => n.startsWith("mcp."))).toBe(false);
  });

  it("drops tasks.* when agent task tools are off", () => {
    const names = effectiveToolDescriptors({
      ...ALL_ENABLED,
      tasks: { enabled: true, agentToolsEnabled: false },
    }).map((d) => d.name);
    expect(names.some((n) => n.startsWith("tasks."))).toBe(false);
  });
});

describe("searchTools", () => {
  it("resolves the alias that started this issue", () => {
    // A user searched /skills for "filesystem", found nothing, and
    // concluded the agent could not touch files (#71). No tool is
    // literally named "filesystem", so the alias has to carry it.
    const hits = searchTools("filesystem", DEFAULT_TOOL_DESCRIPTORS);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits).toContain("os.fs.write");
  });

  it("routes git to the os.git family, not the shell", () => {
    const hits = searchTools("git", DEFAULT_TOOL_DESCRIPTORS);
    expect(hits).toContain("os.git.status");
    expect(hits).toContain("os.git.log");
    expect(hits).not.toContain("os.shell.run");
  });

  it("matches a family prefix directly", () => {
    expect(searchTools("browser", DEFAULT_TOOL_DESCRIPTORS)).toContain(
      "browser.navigate",
    );
  });

  it("matches a substring of a tool name", () => {
    expect(searchTools("grep", DEFAULT_TOOL_DESCRIPTORS)).toContain("os.fs.grep");
  });

  it("is case-insensitive", () => {
    expect(searchTools("BROWSER", DEFAULT_TOOL_DESCRIPTORS)).toContain(
      "browser.navigate",
    );
  });

  it("returns nothing for an unrelated query", () => {
    expect(searchTools("kubernetes", DEFAULT_TOOL_DESCRIPTORS)).toEqual([]);
  });

  it("returns nothing for an empty query", () => {
    expect(searchTools("   ", DEFAULT_TOOL_DESCRIPTORS)).toEqual([]);
  });
});

describe("renderToolsOverview", () => {
  it("names the config-dependence and points at /skills", () => {
    const out = renderToolsOverview(DEFAULT_TOOL_DESCRIPTORS);
    expect(out).toContain("enabled under the current config");
    expect(out).toContain("/skills");
    expect(out).toContain("os.fs");
  });

  it("does not repeat single-segment tool names", () => {
    const out = renderToolsOverview(DEFAULT_TOOL_DESCRIPTORS);
    expect(out).toContain("  reply");
    expect(out).not.toContain("reply  reply");
    expect(out).not.toContain("finish  finish");
  });

  it("omits families disabled by config", () => {
    const descriptors = effectiveToolDescriptors({
      ...ALL_ENABLED,
      browser: { enabled: false },
    });
    const out = renderToolsOverview(descriptors);
    // The footer hint still says `/tools browser`; only the family
    // lines (two-space indented) must lose the browser entry.
    expect(out).not.toMatch(/^ {2}browser/m);
  });
});

describe("renderToolsSearch", () => {
  it("lists matches with their full names", () => {
    const out = renderToolsSearch("filesystem", DEFAULT_TOOL_DESCRIPTORS);
    expect(out).toContain("os.fs.read");
  });

  it("says so plainly on a miss and offers the next step", () => {
    const out = renderToolsSearch("kubernetes", DEFAULT_TOOL_DESCRIPTORS);
    expect(out).toContain("no built-in tool matches");
    expect(out).toContain("/tools");
    expect(out).toContain("/skills");
  });

  it("tells apart missing tools from config-disabled tools", () => {
    const descriptors = effectiveToolDescriptors({
      ...ALL_ENABLED,
      browser: { enabled: false },
    });
    const out = renderToolsSearch("browser", descriptors);
    expect(out).toContain("turned off in your config");
    expect(out).toContain("browser.navigate");
  });
});
