import { describe, expect, it } from "vitest";

import {
  listToolFamilies,
  renderToolsOverview,
  renderToolsSearch,
  searchTools,
} from "./tools-listing.js";

describe("listToolFamilies", () => {
  it("groups tools by namespace and sorts both levels", () => {
    const families = listToolFamilies();
    const names = families.map((f) => f.family);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    const fs = families.find((f) => f.family === "os.fs");
    expect(fs).toBeDefined();
    expect(fs!.tools).toContain("os.fs.read");
    expect(fs!.tools).toContain("os.fs.write");
    expect(fs!.tools).toEqual([...fs!.tools].sort((a, b) => a.localeCompare(b)));
  });

  it("covers the families users ask about", () => {
    const names = listToolFamilies().map((f) => f.family);
    for (const family of ["os.fs", "os.shell", "os.web", "browser"]) {
      expect(names).toContain(family);
    }
  });
});

describe("searchTools", () => {
  it("resolves the alias that started this issue", () => {
    // A user searched /skills for "filesystem", found nothing, and
    // concluded the agent could not touch files (#71). No tool is
    // literally named "filesystem", so the alias has to carry it.
    const hits = searchTools("filesystem");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits).toContain("os.fs.write");
  });

  it("matches a family prefix directly", () => {
    expect(searchTools("browser")).toContain("browser.navigate");
  });

  it("matches a substring of a tool name", () => {
    expect(searchTools("grep")).toEqual(["os.fs.grep"]);
  });

  it("is case-insensitive", () => {
    expect(searchTools("BROWSER")).toContain("browser.navigate");
  });

  it("returns nothing for an unrelated query", () => {
    expect(searchTools("kubernetes")).toEqual([]);
  });

  it("returns nothing for an empty query", () => {
    expect(searchTools("   ")).toEqual([]);
  });
});

describe("renderToolsOverview", () => {
  it("states the tools are built in and points at /skills", () => {
    const out = renderToolsOverview();
    expect(out).toContain("always available");
    expect(out).toContain("/skills");
    expect(out).toContain("os.fs");
  });
});

describe("renderToolsSearch", () => {
  it("lists matches with their full names", () => {
    const out = renderToolsSearch("filesystem");
    expect(out).toContain("os.fs.read");
  });

  it("says so plainly on a miss and offers the next step", () => {
    const out = renderToolsSearch("kubernetes");
    expect(out).toContain("no built-in tool matches");
    expect(out).toContain("/tools");
    expect(out).toContain("/skills");
  });
});
