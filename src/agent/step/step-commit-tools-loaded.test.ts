import { describe, expect, it } from "vitest";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { applyStateEffects } from "./step-commit.js";

describe("applyStateEffects: loaded tools (ATO-558)", () => {
  it("records every entry of `toolsLoaded` (tool.search) as well as a single `toolLoaded` (tool.view)", () => {
    const session = createEmptySessionState({ id: "s", workingDir: "/w" });
    const entry = (name: string) => ({ name, summary: `${name} summary`, argsSchema: "{ x: string }", source: "explicit" as const });
    const result = compressToolResult({
      tool: "tool.search",
      status: "ok",
      output: "hits",
      details: { toolsLoaded: [entry("mcp.a.one"), entry("mcp.a.two"), { name: 5 }] },
    });
    const next = applyStateEffects(session, result, "cloud");
    expect(next.loadedTools.map((t) => t.name)).toEqual(["mcp.a.one", "mcp.a.two"]);

    const view = compressToolResult({ tool: "tool.view", status: "ok", output: "x", details: { toolLoaded: entry("os.git.show") } });
    expect(applyStateEffects(next, view, "cloud").loadedTools.map((t) => t.name)).toEqual(["mcp.a.one", "mcp.a.two", "os.git.show"]);
  });

  it("ignores a malformed `toolsLoaded`", () => {
    const session = createEmptySessionState({ id: "s", workingDir: "/w" });
    const result = compressToolResult({ tool: "tool.search", status: "ok", output: "x", details: { toolsLoaded: "nope" } });
    expect(applyStateEffects(session, result, "cloud").loadedTools).toEqual([]);
  });
});
