import { describe, it, expect } from "vitest";
import { buildToolViewTool } from "./tool-view.js";
import { ToolRegistry } from "../tool-registry.js";

describe("buildToolViewTool", () => {
  it("returns ok and toolLoaded for a rare tool", async () => {
    const tool = buildToolViewTool();
    const ctx = {
      workingDir: "/w",
      sessionId: "s1",
      stepIndex: 0,
      signal: new AbortController().signal,
    };
    const r = await tool.run({ name: "os.git.show" }, ctx);
    expect(r.status).toBe("ok");
    const tl = r.details.toolLoaded as { name: string; source: string };
    expect(tl.name).toBe("os.git.show");
    expect(tl.source).toBe("explicit");
  });

  it("rejects a frequent (common) tool name", async () => {
    const tool = buildToolViewTool();
    const ctx = {
      workingDir: "/w",
      sessionId: "s1",
      stepIndex: 0,
      signal: new AbortController().signal,
    };
    await expect(tool.run({ name: "browser.navigate" }, ctx)).rejects.toThrow(
      /not in the # extras list/,
    );
  });
});

describe("buildToolViewTool in registry", () => {
  it("registers as tool.view", () => {
    const r = new ToolRegistry();
    r.register(buildToolViewTool());
    expect(r.has("tool.view")).toBe(true);
  });
});
