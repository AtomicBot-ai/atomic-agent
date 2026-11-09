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

describe("buildToolViewTool and the compact prompt", () => {
  it("loads a tool only the compact scaffold collapses to a one-liner", async () => {
    // verify.run is frequent in the full prompt and `compact.tier: "rare"`.
    const tool = buildToolViewTool();
    const r = await tool.run(
      { name: "verify.run" },
      { workingDir: "/w", sessionId: "s1", stepIndex: 0, signal: new AbortController().signal },
    );
    expect(r.status).toBe("ok");
    const tl = r.details.toolLoaded as { name: string; argsSchema: string };
    expect(tl.name).toBe("verify.run");
    expect(tl.argsSchema).toContain("kind: 'command' | 'service' | 'page'");
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

describe("buildToolViewTool in search mode (ATO-558)", () => {
  const ctx = { workingDir: "/w", sessionId: "s1", stepIndex: 0, signal: new AbortController().signal };
  const slack = {
    name: "mcp.slack.chat_post_message",
    summary: "[mcp:slack] Send a message to a Slack channel",
    argsSchema: "{ channel: string, text: string }",
  };

  it("loads a statically frequent tool that search mode deferred", async () => {
    const tool = buildToolViewTool({ deferred: () => ({ descriptors: [], deferred: new Set(["os.git.status"]) }) });
    const r = await tool.run({ name: "os.git.status" }, ctx);
    expect((r.details.toolLoaded as { name: string }).name).toBe("os.git.status");
  });

  it("loads a deferred MCP tool from the search catalog", async () => {
    const tool = buildToolViewTool({ deferred: () => ({ descriptors: [slack], deferred: new Set([slack.name]) }) });
    const r = await tool.run({ name: slack.name }, ctx);
    expect(r.details.toolLoaded).toMatchObject({ name: slack.name, argsSchema: slack.argsSchema });
  });

  it("still refuses a frequent tool search mode kept in full, and points an unknown name at tool.search", async () => {
    const tool = buildToolViewTool({ deferred: () => ({ descriptors: [slack], deferred: new Set([slack.name]) }) });
    await expect(tool.run({ name: "browser.navigate" }, ctx)).rejects.toThrow(/not in the # extras list/);
    await expect(tool.run({ name: "mcp.nope.x" }, ctx)).rejects.toThrow(/call tool\.search/);
    await expect(buildToolViewTool().run({ name: "mcp.nope.x" }, ctx)).rejects.toThrow(/^tool\.view: unknown tool: mcp\.nope\.x$/);
  });
});
