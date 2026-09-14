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

describe("buildToolViewTool under a tool role", () => {
  const ctxFor = (toolRole: "builder" | "orchestrator" | "full") => ({
    workingDir: "/w",
    sessionId: "s1",
    stepIndex: 0,
    signal: new AbortController().signal,
    toolRole,
  });

  it("loads a frequent tool that is outside the turn's role", async () => {
    // An orchestrator's prefix lists `os.fs.write` by name only; loading
    // it is what makes it described (and, on a local model, emittable).
    const tool = buildToolViewTool();
    const r = await tool.run({ name: "os.fs.write" }, ctxFor("orchestrator"));
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("outside this turn's `orchestrator` tool set");
    const tl = r.details.toolLoaded as { name: string; source: string };
    expect(tl.name).toBe("os.fs.write");
    expect(tl.source).toBe("explicit");
  });

  it("still refuses a frequent tool the role already describes in full", async () => {
    const tool = buildToolViewTool();
    await expect(
      tool.run({ name: "os.fs.read" }, ctxFor("orchestrator")),
    ).rejects.toThrow(/already in the stable prefix/);
    await expect(
      tool.run({ name: "os.fs.write" }, ctxFor("full")),
    ).rejects.toThrow(/already in the stable prefix/);
  });

  it("keeps loading rare tools whatever the role, and says when the role is why", async () => {
    const tool = buildToolViewTool();
    // In role (full admits everything) and rare: the plain load.
    const inRole = await tool.run({ name: "os.git.show" }, ctxFor("full"));
    expect(inRole.status).toBe("ok");
    expect(inRole.summary).not.toContain("outside this turn's");
    // Rare AND outside builder (no git tools there): loaded, with the note.
    const outside = await tool.run({ name: "os.git.show" }, ctxFor("builder"));
    expect(outside.status).toBe("ok");
    expect(outside.summary).toContain("outside this turn's `builder` tool set");
  });
});

describe("buildToolViewTool in registry", () => {
  it("registers as tool.view", () => {
    const r = new ToolRegistry();
    r.register(buildToolViewTool());
    expect(r.has("tool.view")).toBe(true);
  });
});
