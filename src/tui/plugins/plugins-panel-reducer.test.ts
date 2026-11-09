import { describe, expect, it } from "vitest";
import type { PluginsAction } from "./plugins-actions.js";
import { reducePanel } from "./plugins-panel-reducer.js";
import { createInitialPluginsPanelState, pluginsPanelLines, selectedPluginsLine, type PluginsPanelState } from "./plugins-panel-state.js";
import { NO_CODE, plugin } from "./plugins-test-rows.js";

function run(panel: PluginsPanelState, ...actions: PluginsAction[]): PluginsPanelState {
  return actions.reduce(reducePanel, panel);
}

const synced = (rows = [plugin(), NO_CODE]): PluginsAction => ({ type: "plugins_synced", rows });

describe("plugins panel reducer", () => {
  it("lists plugins and opens one plugin's parts under it", () => {
    const panel = run(createInitialPluginsPanelState(), synced());
    expect(panel.loaded).toBe(true);
    expect(pluginsPanelLines(panel).map((l) => l.kind)).toEqual(["plugin", "plugin"]);
    const open = run(panel, { type: "plugins_expand_toggled" });
    expect(open.expanded).toBe("demo");
    expect(pluginsPanelLines(open).map((l) => (l.kind === "part" ? l.part.id : l.plugin.name))).toEqual([
      "demo", "skill:review", "mcp:gh", "notes",
    ]);
    expect(run(open, { type: "plugins_expand_toggled" }).expanded).toBeNull();
  });

  it("collapses back onto the plugin row from one of its parts", () => {
    const panel = run(createInitialPluginsPanelState(), synced(), { type: "plugins_expand_toggled" }, { type: "plugins_moved", delta: 2 });
    expect(selectedPluginsLine(panel)?.kind).toBe("part");
    const closed = run(panel, { type: "plugins_collapsed" });
    expect(closed.expanded).toBeNull();
    expect(selectedPluginsLine(closed)).toMatchObject({ kind: "plugin", plugin: { name: "demo" } });
  });

  it("keeps the cursor on the same part across a re-sync", () => {
    const panel = run(createInitialPluginsPanelState(), synced(), { type: "plugins_expand_toggled" }, { type: "plugins_moved", delta: 2 });
    const resynced = run(panel, synced([plugin({ name: "aaa", parts: [] }), plugin(), NO_CODE]));
    const line = selectedPluginsLine(resynced);
    expect(line?.kind === "part" ? line.part.id : null).toBe("mcp:gh");
  });

  it("drops the open plugin when it disappears and clamps the cursor", () => {
    const panel = run(createInitialPluginsPanelState(), synced(), { type: "plugins_moved", delta: 1 }, { type: "plugins_expand_toggled" });
    const resynced = run(panel, synced([plugin()]));
    expect(resynced.expanded).toBeNull();
    expect(resynced.selected).toBe(0);
  });

  it("asks before removing or allowing code, only on a plugin row, and only allows code that exists", () => {
    const panel = run(createInitialPluginsPanelState(), synced());
    expect(run(panel, { type: "plugins_remove_started" }).mode).toBe("remove");
    expect(run(panel, { type: "plugins_allow_code_started" }).mode).toBe("allow-code");
    const noCode = run(panel, { type: "plugins_moved", delta: 1 });
    expect(run(noCode, { type: "plugins_allow_code_started" }).mode).toBe("list");
    const onPart = run(panel, { type: "plugins_expand_toggled" }, { type: "plugins_moved", delta: 1 });
    expect(run(onPart, { type: "plugins_remove_started" }).mode).toBe("list");
    expect(run(panel, { type: "plugins_remove_started" }, { type: "plugins_cancelled" }).mode).toBe("list");
  });

  it("does not move while a question is open", () => {
    const asking = run(createInitialPluginsPanelState(), synced(), { type: "plugins_remove_started" });
    expect(run(asking, { type: "plugins_moved", delta: 1 }).selected).toBe(0);
  });

  it("settles busy, closes the question and keeps the message", () => {
    const panel = run(
      createInitialPluginsPanelState(),
      synced(),
      { type: "plugins_remove_started" },
      { type: "plugins_action_started" },
    );
    expect(panel.busy).toBe(true);
    const done = run(panel, { type: "plugins_action_settled", message: "Removed demo." });
    expect(done).toMatchObject({ busy: false, mode: "list", message: "Removed demo.", lastError: null });
    expect(run(done, { type: "plugins_message_cleared" }).message).toBeNull();
  });
});
