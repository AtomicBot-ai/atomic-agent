import type { PluginOverview, PluginPartOverview } from "../../plugins/plugin-overview.js";

/** Test rows for the Plugins panel suites. Imported by tests only. */
export function part(over: Partial<PluginPartOverview> = {}): PluginPartOverview {
  return { id: "skill:review", kind: "skill", name: "review", enabled: true, active: true, runsCode: false, missingKeys: [], ...over };
}

export function plugin(over: Partial<PluginOverview> = {}): PluginOverview {
  return {
    name: "demo",
    version: "1.2.0",
    description: "Demo plugin",
    format: "claude",
    source: { kind: "local", path: "/src/demo" },
    sourceLabel: "folder /src/demo",
    enabled: true,
    filesOk: true,
    error: null,
    counts: { skills: 1, mcpServers: 1, hooks: 0, commands: 0, agents: 0 },
    runsCode: true,
    trust: "code-off",
    codeParts: ["local MCP servers: gh"],
    needsKey: true,
    missingKeys: ["GITHUB_TOKEN"],
    parts: [
      part(),
      part({ id: "mcp:gh", kind: "mcp", name: "gh", runsCode: true, active: false, missingKeys: ["GITHUB_TOKEN"] }),
    ],
    notes: [],
    installedAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

export const NO_CODE = plugin({
  name: "notes",
  runsCode: false,
  trust: "no-code",
  codeParts: [],
  needsKey: false,
  missingKeys: [],
  counts: { skills: 1, mcpServers: 0, hooks: 0, commands: 0, agents: 0 },
  parts: [part({ id: "skill:notes", name: "notes" })],
});
