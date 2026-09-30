import type { Key } from "ink";
import { describe, expect, it, vi } from "vitest";

import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState, type TuiSessionInfo } from "../tui-state.js";
import { handleMcpTabKey } from "./mcp-key-bindings.js";
import type { McpPanelState, McpServerRow } from "./mcp-panel-state.js";

const SESSION: TuiSessionInfo = {
  sessionId: null,
  workingDir: "/tmp",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: true,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

function emptyKey(): Key {
  return {
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
  };
}

function row(name: string): McpServerRow {
  return {
    name,
    description: "",
    state: "up",
    trust: "approval_gated",
    transportKind: "stdio",
    toolCount: 0,
    resourceCount: 0,
    promptCount: 0,
    lastError: null,
  };
}

function press(input: string, panel: Partial<McpPanelState> = {}) {
  const initial = createInitialTuiState(SESSION);
  const callbacks: TuiAppCallbacks = {
    onMcpRestartServer: vi.fn(),
    onMcpToggleServerEnabled: vi.fn(),
  } as unknown as TuiAppCallbacks;
  const handled = handleMcpTabKey(input, emptyKey(), {
    state: {
      ...initial,
      uiMode: "debug",
      activeTab: "mcp",
      mcpPanel: { ...initial.mcpPanel, ...panel },
    },
    dispatch: vi.fn(),
    callbacks,
  });
  return { handled, callbacks };
}

const LIST = { rows: [row("docs"), row("github")], cursor: 1 };

describe("MCP tab restart / enable keys", () => {
  it("R restarts the server under the list cursor", () => {
    const { handled, callbacks } = press("R", LIST);
    expect(handled).toBe(true);
    expect(callbacks.onMcpRestartServer).toHaveBeenCalledWith("github");
    expect(callbacks.onMcpToggleServerEnabled).not.toHaveBeenCalled();
  });

  it("e toggles enabled for the server under the list cursor", () => {
    const { handled, callbacks } = press("e", LIST);
    expect(handled).toBe(true);
    expect(callbacks.onMcpToggleServerEnabled).toHaveBeenCalledWith("github");
    expect(callbacks.onMcpRestartServer).not.toHaveBeenCalled();
  });

  it("R / e act on the open server in detail mode", () => {
    const detail = {
      mode: "detail" as const,
      ...LIST,
      detail: {
        name: "docs",
        state: "up" as const,
        description: "",
        trust: "approval_gated" as const,
        transport: "stdio: x",
        lastError: null,
        tools: [],
        resources: [],
        prompts: [],
      },
    };
    expect(
      press("R", detail).callbacks.onMcpRestartServer,
    ).toHaveBeenCalledWith("docs");
    expect(
      press("e", detail).callbacks.onMcpToggleServerEnabled,
    ).toHaveBeenCalledWith("docs");
  });

  it("consumes the keys without a callback when the list is empty", () => {
    const { handled, callbacks } = press("R");
    expect(handled).toBe(true);
    expect(callbacks.onMcpRestartServer).not.toHaveBeenCalled();
  });

  it("lowercase r still refreshes instead of restarting", () => {
    const { callbacks } = press("r", LIST);
    expect(callbacks.onMcpRestartServer).not.toHaveBeenCalled();
  });

  it("stays out of the way while the remove confirm is open", () => {
    const { callbacks } = press("e", {
      ...LIST,
      removeConfirm: { name: "docs", error: null, submitting: false },
    });
    expect(callbacks.onMcpToggleServerEnabled).not.toHaveBeenCalled();
  });
});
