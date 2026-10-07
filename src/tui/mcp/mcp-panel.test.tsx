import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useInput } from "ink";
import { render } from "ink-testing-library";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "../../config/config-cache.js";
import { McpPanel } from "./mcp-panel.js";
import { MouseProvider } from "../mouse/mouse-context.js";
import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { MouseTargetRegistry } from "../mouse/mouse-registry.js";
import { fakeSession } from "../test-fixtures.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { handleMcpTabKey } from "./mcp-key-bindings.js";
import type { McpServerRow } from "./mcp-panel-state.js";
import { reduceMcpAction } from "./mcp-reducer.js";

function row(name: string): McpServerRow {
  return {
    name, description: "", state: "up", trust: "approval_gated",
    transportKind: "stdio", toolCount: 0, resourceCount: 0,
    promptCount: 0, lastError: null,
  };
}

function mount() {
  const registry = new MouseTargetRegistry();
  const initial = createInitialTuiState(fakeSession());
  let current: TuiState = { ...initial, uiMode: "debug" as const, activeTab: "mcp" as const,
    mcpPanel: { ...initial.mcpPanel, rows: [row("docs"), row("github")], cursor: 1 } };
  const actions: TuiAction[] = [];
  const handled: boolean[] = [];
  const callbacks = {
    onApprovalDecision: vi.fn(), onAbort: vi.fn(), onQuit: vi.fn(), onMessageSubmitted: vi.fn(),
    onMcpDetailRequested: vi.fn(), onMcpRemoveServer: vi.fn(), onMcpAddServerSubmit: vi.fn(),
  } satisfies TuiAppCallbacks;
  let dispatch: (action: TuiAction) => void = () => { throw new Error("surface not mounted"); };
  function Surface() {
    const [state, setState] = useState<TuiState>(current);
    current = state;
    dispatch = (action) => {
      actions.push(action);
      setState((prev) => reduceMcpAction(prev, action) ?? prev);
    };
    useInput((input, key) => {
      handled.push(handleMcpTabKey(input, key, { state, dispatch, callbacks }));
    });
    return (
      <MouseProvider registry={registry} dispatch={dispatch} callbacks={callbacks} getState={() => current}>
        <McpPanel
          panel={state.mcpPanel}
          onAddJsonChange={(json) => dispatch({ type: "mcp_add_json_changed", json })}
          onAddSubmit={callbacks.onMcpAddServerSubmit}
          onAddCancel={() => dispatch({ type: "mcp_add_modal_closed" })}
        />
      </MouseProvider>
    );
  }
  const view = render(<Surface />);
  return { ...view, registry, callbacks, actions, handled, state: () => current, dispatch: (action: TuiAction) => dispatch(action) };
}

type Mounted = ReturnType<typeof mount>;
const mounted: Mounted[] = [];
const wait = async (condition: () => boolean) => vi.waitFor(() => expect(condition()).toBe(true), { timeout: 2000, interval: 20 });

async function clickLabel(view: Mounted, label: string): Promise<void> {
  await vi.waitFor(() => {
    const lines = (view.lastFrame() ?? "").split("\n");
    const y = lines.findIndex((line) => line.includes(label));
    expect(y).toBeGreaterThanOrEqual(0);
    const x = lines[y]!.indexOf(label);
    const event: TuiMouseEvent = { kind: "press", button: "left", wheel: null, x, y, shift: false, alt: false, ctrl: false };
    // A claimed event executes once; retries only wait for Ink target registration.
    expect(view.registry.dispatch(event)).toBe(true);
  }, { timeout: 2000, interval: 20 });
}

describe("MCP panel input seams", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "mcp-panel-"));
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", stateDir);
    resetConfigCache();
  });
  afterEach(() => {
    for (const view of mounted.splice(0)) view.unmount();
    vi.unstubAllEnvs();
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });
  function surface() {
    const view = mount();
    mounted.push(view);
    return view;
  }

  it("mouse selects a row, then opens the same detail as keyboard Enter", async () => {
    const view = surface();
    await clickLabel(view, "docs");
    await wait(() => view.state().mcpPanel.cursor === 0);
    expect(view.callbacks.onMcpDetailRequested).not.toHaveBeenCalled();
    await clickLabel(view, "docs");
    expect(view.callbacks.onMcpDetailRequested).toHaveBeenNthCalledWith(1, "docs");
    view.stdin.write("\r");
    await wait(() => view.callbacks.onMcpDetailRequested.mock.calls.length === 2);
    expect(view.callbacks.onMcpDetailRequested).toHaveBeenNthCalledWith(2, "docs");
  });

  it("confirmation removes its anchored server after the background list cursor changes", async () => {
    const view = surface();
    await wait(() => (view.lastFrame() ?? "").includes("github"));
    view.stdin.write("d");
    await wait(() => view.state().mcpPanel.removeConfirm?.name === "github");
    view.dispatch({ type: "mcp_cursor_set", row: 0 });
    await wait(() => view.state().mcpPanel.cursor === 0);
    expect(view.lastFrame()).toContain("remove MCP server?");
    view.stdin.write("y");
    await wait(() => view.callbacks.onMcpRemoveServer.mock.calls.length === 1);
    expect(view.callbacks.onMcpRemoveServer).toHaveBeenCalledWith("github");
    expect(view.actions).toContainEqual({ type: "mcp_remove_submit_requested", name: "github" });
  });

  it("busy remove confirmation consumes repeated submit keys", async () => {
    const view = surface();
    view.dispatch({ type: "mcp_remove_confirm_opened", name: "docs" });
    view.dispatch({ type: "mcp_remove_submitting_started" });
    await wait(() => view.state().mcpPanel.removeConfirm?.submitting === true);
    view.stdin.write("y");
    await wait(() => view.handled.length > 0);
    expect(view.handled.at(-1)).toBe(true);
    expect(view.callbacks.onMcpRemoveServer).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain("working…");
  });

  it("add-modal keys fall through to the editor and submit the JSON buffer", async () => {
    const view = surface();
    await wait(() => (view.lastFrame() ?? "").includes("github"));
    view.stdin.write("n");
    await wait(() => (view.lastFrame() ?? "").includes("+ add MCP server"));
    const json = '{"name":"docs","command":"fixture"}';
    view.stdin.write(json);
    await wait(() => view.state().mcpPanel.addModal?.json === json);
    expect(view.handled.at(-1)).toBe(false);
    view.stdin.write("\r");
    await wait(() => view.callbacks.onMcpAddServerSubmit.mock.calls.length === 1);
    expect(view.callbacks.onMcpAddServerSubmit).toHaveBeenCalledWith(json);
    expect(view.callbacks.onMcpDetailRequested).not.toHaveBeenCalled();
  });

  it("Escape closes the add editor through its callback", async () => {
    const view = surface();
    view.dispatch({ type: "mcp_add_modal_opened" });
    await wait(() => (view.lastFrame() ?? "").includes("+ add MCP server"));
    view.stdin.write("\u001b");
    await wait(() => view.state().mcpPanel.addModal === null);
    expect(view.actions).toContainEqual({ type: "mcp_add_modal_closed" });
    expect(view.callbacks.onMcpAddServerSubmit).not.toHaveBeenCalled();
  });
});
