import { describe, expect, it, vi } from "vitest";
import type { Key } from "ink";

import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { handlePluginsTabKey } from "./plugins-key-bindings.js";
import { createInitialPluginsPanelState, type PluginsPanelState } from "./plugins-panel-state.js";
import { NO_CODE, plugin } from "./plugins-test-rows.js";

const KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
} as Key;

function ctxOf(panel: Partial<PluginsPanelState>, callbacks: Partial<TuiAppCallbacks> = {}, activeTab = "plugins") {
  const dispatch = vi.fn();
  const state = {
    uiMode: "debug",
    activeTab,
    pluginsPanel: { ...createInitialPluginsPanelState(), loaded: true, rows: [plugin(), NO_CODE], ...panel },
  } as unknown as TuiState;
  return { ctx: { state, dispatch, callbacks: callbacks as TuiAppCallbacks }, dispatch };
}

describe("handlePluginsTabKey", () => {
  it("ignores keys on other tabs", () => {
    const { ctx } = ctxOf({}, {}, "skills");
    expect(handlePluginsTabKey("x", KEY, ctx)).toBe(false);
  });

  it("moves with arrows and j/k, opens parts with enter and closes with ←", () => {
    const { ctx, dispatch } = ctxOf({});
    handlePluginsTabKey("j", KEY, ctx);
    handlePluginsTabKey("", { ...KEY, upArrow: true }, ctx);
    handlePluginsTabKey("", { ...KEY, return: true }, ctx);
    handlePluginsTabKey("", { ...KEY, leftArrow: true }, ctx);
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual([
      { type: "plugins_moved", delta: 1 },
      { type: "plugins_moved", delta: -1 },
      { type: "plugins_expand_toggled" },
      { type: "plugins_collapsed" },
    ]);
  });

  it("switches the plugin with space and a part with enter or space", () => {
    const onPluginToggleRequested = vi.fn();
    const onPluginPartToggleRequested = vi.fn();
    const cbs = { onPluginToggleRequested, onPluginPartToggleRequested };
    handlePluginsTabKey(" ", KEY, ctxOf({}, cbs).ctx);
    expect(onPluginToggleRequested).toHaveBeenCalledWith("demo", false);
    const onPart = ctxOf({ expanded: "demo", selected: 2 }, cbs).ctx;
    handlePluginsTabKey("", { ...KEY, return: true }, onPart);
    handlePluginsTabKey("x", KEY, onPart);
    expect(onPluginPartToggleRequested).toHaveBeenNthCalledWith(1, "demo", "mcp:gh", false);
    expect(onPluginPartToggleRequested).toHaveBeenNthCalledWith(2, "demo", "mcp:gh", false);
  });

  it("asks before allowing code, stops allowed code at once, and skips plugins without code", () => {
    const onPluginCodeTrustRequested = vi.fn();
    const asking = ctxOf({}, { onPluginCodeTrustRequested });
    handlePluginsTabKey("c", KEY, asking.ctx);
    expect(asking.dispatch).toHaveBeenCalledWith({ type: "plugins_allow_code_started" });
    expect(onPluginCodeTrustRequested).not.toHaveBeenCalled();

    const confirm = ctxOf({ mode: "allow-code" }, { onPluginCodeTrustRequested });
    handlePluginsTabKey("y", KEY, confirm.ctx);
    expect(onPluginCodeTrustRequested).toHaveBeenCalledWith("demo", true);

    const allowed = ctxOf({ rows: [plugin({ trust: "code-allowed" })] }, { onPluginCodeTrustRequested });
    handlePluginsTabKey("c", KEY, allowed.ctx);
    expect(onPluginCodeTrustRequested).toHaveBeenLastCalledWith("demo", false);

    const none = ctxOf({ selected: 1 }, { onPluginCodeTrustRequested });
    expect(handlePluginsTabKey("c", KEY, none.ctx)).toBe(true);
    expect(none.dispatch).not.toHaveBeenCalled();
  });

  it("removes only after y; any other key cancels", () => {
    const onPluginRemoveRequested = vi.fn();
    const start = ctxOf({}, { onPluginRemoveRequested });
    handlePluginsTabKey("d", KEY, start.ctx);
    expect(start.dispatch).toHaveBeenCalledWith({ type: "plugins_remove_started" });

    const cancel = ctxOf({ mode: "remove" }, { onPluginRemoveRequested });
    handlePluginsTabKey("n", KEY, cancel.ctx);
    expect(cancel.dispatch).toHaveBeenCalledWith({ type: "plugins_cancelled" });
    expect(onPluginRemoveRequested).not.toHaveBeenCalled();

    const yes = ctxOf({ mode: "remove" }, { onPluginRemoveRequested });
    handlePluginsTabKey("y", KEY, yes.ctx);
    expect(onPluginRemoveRequested).toHaveBeenCalledWith("demo");
  });

  it("swallows keys while busy and refreshes with r", () => {
    const onPluginsRefreshRequested = vi.fn();
    const busy = ctxOf({ busy: true }, { onPluginsRefreshRequested });
    expect(handlePluginsTabKey("r", KEY, busy.ctx)).toBe(true);
    expect(onPluginsRefreshRequested).not.toHaveBeenCalled();
    handlePluginsTabKey("r", KEY, ctxOf({}, { onPluginsRefreshRequested }).ctx);
    expect(onPluginsRefreshRequested).toHaveBeenCalledTimes(1);
  });
});

describe("plugins question counts as a panel modal", () => {
  it("claims the global keys only while remove or allow-code is asked", async () => {
    const { isPanelModalOpen } = await import("../app-key-bindings.js");
    const stateOf = (mode: PluginsPanelState["mode"]) => ({
      uiMode: "debug",
      activeTab: "plugins",
      pluginsPanel: { ...createInitialPluginsPanelState(), mode },
      tasksPanel: { mode: "list", cancelConfirm: null, searchOpen: false },
      skillsPanel: { mode: "list", installConfirm: null, removeConfirm: null },
      memoryPanel: { mode: "list" },
      localModelsPanel: { mode: "list", removeConfirmId: null, notifyPrompt: null },
      telegramPanel: { mode: "list" },
      mcpPanel: { addModal: null, removeConfirm: null },
      providersPanel: { wizard: null, removeConfirm: null },
    }) as unknown as TuiState;
    expect(isPanelModalOpen(stateOf("list"))).toBe(false);
    expect(isPanelModalOpen(stateOf("remove"))).toBe(true);
    expect(isPanelModalOpen(stateOf("allow-code"))).toBe(true);
  });
});
