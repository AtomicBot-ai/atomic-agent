import { describe, expect, it } from "vitest";
import type { ContextUsagePart } from "../../session/context-usage.js";
import { contextHint } from "./context-hint.js";
import type { ContextUsageView } from "./select-context-usage.js";

function view(
  parts: ContextUsagePart[],
  overrides: Partial<ContextUsageView> = {},
): ContextUsageView {
  return {
    tokens: 20_000,
    contextWindow: 32_768,
    percent: 61,
    conversationTokens: 4000,
    conversationCap: 8000,
    conversationPercent: 50,
    capSource: "config",
    droppedTurns: 0,
    pairs: 2,
    pairsCap: 20,
    droppedPairs: 0,
    pairCosts: [2000, 2000],
    sections: [],
    parts,
    toolSearchActive: false,
    ...overrides,
  };
}

const scaffold = (label: string, tokens: number, mcpServer?: string): ContextUsagePart => ({
  parent: "prompt scaffold",
  label,
  tokens,
  ...(mcpServer ? { mcpServer } : {}),
});

describe("contextHint (ATO-2355)", () => {
  it("names an MCP server above 10% of a small window", () => {
    const hint = contextHint(view([scaffold("built-in tools", 1000), scaffold("mcp github", 5000, "github")]));
    expect(hint).toEqual([
      "tip: mcp github takes 15% of the window",
      "turn it off in /mcp, or load tools on demand:",
      "atag config set agent.tools.search on, then restart",
    ]);
  });

  it("adds a server's prefix and loaded-tools rows together", () => {
    const hint = contextHint(
      view([
        scaffold("mcp github", 2000, "github"),
        { parent: "loaded tools", label: "mcp github", tokens: 2000, mcpServer: "github" },
      ]),
    );
    expect(hint?.[0]).toBe("tip: mcp github takes 12% of the window");
  });

  it("does not suggest search mode when it is already on", () => {
    const hint = contextHint(view([scaffold("mcp github", 5000, "github")], { toolSearchActive: true }));
    expect(hint?.[1]).toBe("turn the server off in /mcp to free it");
  });

  it("suggests search mode for a heavy built-in catalog", () => {
    const hint = contextHint(view([scaffold("built-in tools", 6000)]));
    expect(hint).toEqual([
      "tip: built-in tools take 18% of the window",
      "to load them on demand, run",
      "atag config set agent.tools.search on, then restart",
    ]);
  });

  // ATO-2772: the tip named the key but not how to set it. The line it
  // names must be a real `atag config set` call, short enough for the
  // panel's 55 inner columns.
  it("names the command that turns search mode on", () => {
    const hint = contextHint(view([scaffold("built-in tools", 6000)])) ?? [];
    const command = hint.at(-1) ?? "";
    expect(command).toMatch(/^atag config set agent\.tools\.search on\b/);
    for (const line of hint) expect(line.length).toBeLessThanOrEqual(55);
  });

  it("stays quiet on a big window, an unknown one, or small parts", () => {
    const heavy = [scaffold("mcp github", 20_000, "github")];
    expect(contextHint(view(heavy, { contextWindow: 131_072 }))).toBeNull();
    expect(contextHint(view(heavy, { contextWindow: null }))).toBeNull();
    expect(contextHint(view([scaffold("mcp github", 3000, "github")]))).toBeNull();
  });
});
