import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { createInitialPluginsPanelState, type PluginsPanelState } from "../plugins-panel-state.js";
import { NO_CODE, plugin } from "../plugins-test-rows.js";
import { PluginsPanel } from "./plugins-panel.js";

function frame(over: Partial<PluginsPanelState>): string {
  const panel = { ...createInitialPluginsPanelState(), loaded: true, rows: [plugin(), NO_CODE], ...over };
  const { lastFrame, unmount } = render(<PluginsPanel panel={panel} maxRows={14} />);
  const text = lastFrame() ?? "";
  unmount();
  return text;
}

describe("PluginsPanel", () => {
  it("shows each plugin with counts, the code mark, trust and the needs-a-key mark", () => {
    const text = frame({});
    expect(text).toContain("2 installed · 2 on · 1 need a key");
    expect(text).toContain("demo");
    expect(text).toContain("1 skill, 1 MCP server");
    expect(text).toContain("[runs code · code off]");
    expect(text).toContain("[needs a key]");
    expect(text).toContain("[no code]");
    expect(text).toContain("set GITHUB_TOKEN in ~/.atomic-agent/.env");
  });

  it("lists an opened plugin's parts with their own switches", () => {
    const text = frame({ expanded: "demo" });
    expect(text).toContain("skill review");
    expect(text).toContain("MCP server gh");
    expect(text).toContain("off until code is allowed");
    expect(text).toContain("needs GITHUB_TOKEN");
  });

  it("asks on the row before removing or allowing code", () => {
    expect(frame({ mode: "remove" })).toContain("remove this plugin and its files? y / esc");
    expect(frame({ mode: "allow-code" })).toContain("allow local MCP servers: gh? y / esc");
  });

  it("points to the CLI when nothing is installed", () => {
    const text = frame({ rows: [] });
    expect(text).toContain("No plugins installed.");
    expect(text).toContain("atomic-agent plugin install <folder>");
  });

  it("shows a plugin whose files are gone", () => {
    expect(frame({ rows: [plugin({ filesOk: false, error: "gone", parts: [] })] })).toContain("files missing");
  });
});
