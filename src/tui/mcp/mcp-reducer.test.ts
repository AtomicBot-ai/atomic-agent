import { describe, expect, it } from "vitest";

import { createInitialTuiState } from "../tui-state.js";
import type { TuiAction } from "../tui-action.js";
import { reduceMcpAction } from "./mcp-reducer.js";
import type {
  McpServerDetail,
  McpServerRow,
} from "./mcp-panel-state.js";

function dispatch(state = createInitialTuiState(), action: TuiAction) {
  const next = reduceMcpAction(state, action);
  return next ?? state;
}

function row(name: string, overrides: Partial<McpServerRow> = {}): McpServerRow {
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
    ...overrides,
  };
}

function detail(name: string): McpServerDetail {
  return {
    name,
    state: "up",
    description: "",
    trust: "approval_gated",
    transport: "stdio: cmd",
    lastError: null,
    tools: [],
    resources: [],
    prompts: [],
  };
}

describe("reduceMcpAction", () => {
  it("returns null for non-mcp actions", () => {
    const initial = createInitialTuiState();
    expect(
      reduceMcpAction(initial, { type: "runtime_info", line: "x" } as TuiAction),
    ).toBeNull();
  });

  it("mcp_refresh_started flips loading on and clears lastError", () => {
    let s = createInitialTuiState();
    s = { ...s, mcpPanel: { ...s.mcpPanel, lastError: "boom" } };
    const next = dispatch(s, { type: "mcp_refresh_started" });
    expect(next.mcpPanel.loading).toBe(true);
    expect(next.mcpPanel.lastError).toBeNull();
  });

  it("mcp_rows_loaded clamps cursor and stores rows + hint", () => {
    let s = createInitialTuiState();
    s = { ...s, mcpPanel: { ...s.mcpPanel, cursor: 99 } };
    const next = dispatch(s, {
      type: "mcp_rows_loaded",
      rows: [row("a"), row("b")],
      emptyHint: null,
      at: 1000,
    });
    expect(next.mcpPanel.rows.map((r) => r.name)).toEqual(["a", "b"]);
    expect(next.mcpPanel.cursor).toBe(1);
    expect(next.mcpPanel.lastRefreshedAt).toBe(1000);
    expect(next.mcpPanel.loading).toBe(false);
  });

  it("mcp_cursor_moved is bounded by row count", () => {
    let s = createInitialTuiState();
    s = {
      ...s,
      mcpPanel: { ...s.mcpPanel, rows: [row("a"), row("b")], cursor: 0 },
    };
    const upBeyond = dispatch(s, { type: "mcp_cursor_moved", delta: -5 });
    expect(upBeyond.mcpPanel.cursor).toBe(0);
    const downBeyond = dispatch(s, { type: "mcp_cursor_moved", delta: 99 });
    expect(downBeyond.mcpPanel.cursor).toBe(1);
  });

  it("mcp_detail_opened flips mode + stores detail and resets sub-cursor", () => {
    const s = createInitialTuiState();
    const next = dispatch(s, {
      type: "mcp_detail_opened",
      rowKey: "docs",
      detail: detail("docs"),
    });
    expect(next.mcpPanel.mode).toBe("detail");
    expect(next.mcpPanel.detail?.name).toBe("docs");
    expect(next.mcpPanel.detailTab).toBe("tools");
    expect(next.mcpPanel.detailCursor).toBe(0);
  });

  it("mcp_detail_closed returns to list and clears detail state", () => {
    let s = createInitialTuiState();
    s = {
      ...s,
      mcpPanel: {
        ...s.mcpPanel,
        mode: "detail",
        detailRowKey: "docs",
        detail: detail("docs"),
        detailCursor: 5,
      },
    };
    const next = dispatch(s, { type: "mcp_detail_closed" });
    expect(next.mcpPanel.mode).toBe("list");
    expect(next.mcpPanel.detail).toBeNull();
    expect(next.mcpPanel.detailCursor).toBe(0);
  });

  it("mcp_detail_tab_cycled wraps around tools → resources → prompts", () => {
    let s = createInitialTuiState();
    s = {
      ...s,
      mcpPanel: {
        ...s.mcpPanel,
        mode: "detail",
        detail: detail("docs"),
        detailTab: "tools",
      },
    };
    s = dispatch(s, { type: "mcp_detail_tab_cycled", direction: 1 });
    expect(s.mcpPanel.detailTab).toBe("resources");
    s = dispatch(s, { type: "mcp_detail_tab_cycled", direction: 1 });
    expect(s.mcpPanel.detailTab).toBe("prompts");
    s = dispatch(s, { type: "mcp_detail_tab_cycled", direction: 1 });
    expect(s.mcpPanel.detailTab).toBe("tools");
  });

  it("mcp_detail_cursor_moved is bounded by the current tab's item count", () => {
    let s = createInitialTuiState();
    const d = detail("docs");
    s = {
      ...s,
      mcpPanel: {
        ...s.mcpPanel,
        mode: "detail",
        detail: {
          ...d,
          tools: [
            {
              server: "docs",
              rawName: "a",
              qualifiedName: "mcp.docs.a",
              description: "",
              inputSchema: null,
              resourceClass: "approval_gated",
            },
            {
              server: "docs",
              rawName: "b",
              qualifiedName: "mcp.docs.b",
              description: "",
              inputSchema: null,
              resourceClass: "approval_gated",
            },
          ],
        },
        detailTab: "tools",
      },
    };
    s = dispatch(s, { type: "mcp_detail_cursor_moved", delta: 5 });
    expect(s.mcpPanel.detailCursor).toBe(1);
    s = dispatch(s, { type: "mcp_detail_cursor_moved", delta: -99 });
    expect(s.mcpPanel.detailCursor).toBe(0);
  });

  it("mcp_auto_refresh_toggled flips the bit", () => {
    const s = createInitialTuiState();
    const off = dispatch(s, { type: "mcp_auto_refresh_toggled" });
    expect(off.mcpPanel.autoRefresh).toBe(false);
    const on = dispatch(off, { type: "mcp_auto_refresh_toggled" });
    expect(on.mcpPanel.autoRefresh).toBe(true);
  });

  it("mcp_refresh_failed flips loading off and stores error", () => {
    const s = createInitialTuiState();
    const next = dispatch(s, { type: "mcp_refresh_failed", error: "boom" });
    expect(next.mcpPanel.loading).toBe(false);
    expect(next.mcpPanel.lastError).toBe("boom");
  });

  describe("add-server modal", () => {
    it("mcp_add_modal_opened creates an empty modal state", () => {
      const s = createInitialTuiState();
      expect(s.mcpPanel.addModal).toBeNull();
      const next = dispatch(s, { type: "mcp_add_modal_opened" });
      expect(next.mcpPanel.addModal).toEqual({
        json: "",
        error: null,
        submitting: false,
      });
    });

    it("mcp_add_modal_opened is idempotent when the modal is already open", () => {
      let s = createInitialTuiState();
      s = dispatch(s, { type: "mcp_add_modal_opened" });
      s = dispatch(s, { type: "mcp_add_json_changed", json: "preserve me" });
      const next = dispatch(s, { type: "mcp_add_modal_opened" });
      expect(next.mcpPanel.addModal?.json).toBe("preserve me");
    });

    it("mcp_add_json_changed updates the buffer and clears any prior error", () => {
      let s = createInitialTuiState();
      s = dispatch(s, { type: "mcp_add_modal_opened" });
      s = dispatch(s, {
        type: "mcp_add_validation_failed",
        error: "old error",
      });
      const next = dispatch(s, { type: "mcp_add_json_changed", json: '{"a":1}' });
      expect(next.mcpPanel.addModal?.json).toBe('{"a":1}');
      expect(next.mcpPanel.addModal?.error).toBeNull();
    });

    it("mcp_add_submitting_started flips submitting on and clears error", () => {
      let s = createInitialTuiState();
      s = dispatch(s, { type: "mcp_add_modal_opened" });
      s = dispatch(s, { type: "mcp_add_validation_failed", error: "x" });
      const next = dispatch(s, { type: "mcp_add_submitting_started" });
      expect(next.mcpPanel.addModal?.submitting).toBe(true);
      expect(next.mcpPanel.addModal?.error).toBeNull();
    });

    it("mcp_add_validation_failed surfaces the error and stops submitting", () => {
      let s = createInitialTuiState();
      s = dispatch(s, { type: "mcp_add_modal_opened" });
      s = dispatch(s, { type: "mcp_add_submitting_started" });
      const next = dispatch(s, {
        type: "mcp_add_validation_failed",
        error: "bad name",
      });
      expect(next.mcpPanel.addModal?.error).toBe("bad name");
      expect(next.mcpPanel.addModal?.submitting).toBe(false);
    });

    it("mcp_add_failed mirrors mcp_add_validation_failed shape", () => {
      let s = createInitialTuiState();
      s = dispatch(s, { type: "mcp_add_modal_opened" });
      s = dispatch(s, { type: "mcp_add_submitting_started" });
      const next = dispatch(s, {
        type: "mcp_add_failed",
        error: "write failed",
      });
      expect(next.mcpPanel.addModal?.error).toBe("write failed");
      expect(next.mcpPanel.addModal?.submitting).toBe(false);
    });

    it("mcp_add_succeeded closes the modal", () => {
      let s = createInitialTuiState();
      s = dispatch(s, { type: "mcp_add_modal_opened" });
      s = dispatch(s, {
        type: "mcp_add_json_changed",
        json: '{"name":"x"}',
      });
      const next = dispatch(s, { type: "mcp_add_succeeded", name: "x" });
      expect(next.mcpPanel.addModal).toBeNull();
    });

    it("mcp_add_modal_closed wipes the modal state", () => {
      let s = createInitialTuiState();
      s = dispatch(s, { type: "mcp_add_modal_opened" });
      s = dispatch(s, {
        type: "mcp_add_json_changed",
        json: "draft",
      });
      const next = dispatch(s, { type: "mcp_add_modal_closed" });
      expect(next.mcpPanel.addModal).toBeNull();
    });

    it("mcp_add_json_changed flattens newlines / tabs / CR into spaces", () => {
      // Multi-line paste of valid JSON — the reducer must store a
      // single-line representation so the MultiLineEditor does not
      // expand vertically with every pasted line.
      let s = createInitialTuiState();
      s = dispatch(s, { type: "mcp_add_modal_opened" });
      const next = dispatch(s, {
        type: "mcp_add_json_changed",
        json: "{\n\t\"name\": \"x\",\r\n\t\"y\": 1\n}",
      });
      expect(next.mcpPanel.addModal?.json).toBe(
        '{  "name": "x",   "y": 1 }',
      );
      // The flattened form is still parseable JSON.
      expect(() => JSON.parse(next.mcpPanel.addModal!.json)).not.toThrow();
    });

    it("mcp_add_json_changed preserves intra-string content because JSON encodes \\n as escape", () => {
      // Inside a JSON string literal `\n` is two characters (backslash
      // + n), not a newline. The flattener must leave that untouched.
      let s = createInitialTuiState();
      s = dispatch(s, { type: "mcp_add_modal_opened" });
      const json = '{"v":"line1\\nline2"}';
      const next = dispatch(s, { type: "mcp_add_json_changed", json });
      expect(next.mcpPanel.addModal?.json).toBe(json);
    });

    it("error-folding actions are ignored when the modal is closed", () => {
      const s = createInitialTuiState();
      const next = dispatch(s, {
        type: "mcp_add_validation_failed",
        error: "boom",
      });
      expect(next.mcpPanel.addModal).toBeNull();
    });
  });

  describe("remove-server confirm flow", () => {
    it("mcp_remove_confirm_opened seeds the modal with the target name", () => {
      const next = dispatch(createInitialTuiState(), {
        type: "mcp_remove_confirm_opened",
        name: "github",
      });
      expect(next.mcpPanel.removeConfirm).toEqual({
        name: "github",
        error: null,
        submitting: false,
      });
    });

    it("re-opening with a different name overrides stale state", () => {
      let s = createInitialTuiState();
      s = dispatch(s, { type: "mcp_remove_confirm_opened", name: "first" });
      s = dispatch(s, { type: "mcp_remove_submitting_started" });
      s = dispatch(s, { type: "mcp_remove_failed", error: "stale" });
      const next = dispatch(s, {
        type: "mcp_remove_confirm_opened",
        name: "second",
      });
      expect(next.mcpPanel.removeConfirm).toEqual({
        name: "second",
        error: null,
        submitting: false,
      });
    });

    it("mcp_remove_submitting_started flips the flag and clears the error", () => {
      let s = createInitialTuiState();
      s = dispatch(s, { type: "mcp_remove_confirm_opened", name: "x" });
      s = dispatch(s, { type: "mcp_remove_failed", error: "prev" });
      const next = dispatch(s, { type: "mcp_remove_submitting_started" });
      expect(next.mcpPanel.removeConfirm?.submitting).toBe(true);
      expect(next.mcpPanel.removeConfirm?.error).toBeNull();
    });

    it("mcp_remove_failed surfaces the message and resets submitting", () => {
      let s = createInitialTuiState();
      s = dispatch(s, { type: "mcp_remove_confirm_opened", name: "x" });
      s = dispatch(s, { type: "mcp_remove_submitting_started" });
      const next = dispatch(s, {
        type: "mcp_remove_failed",
        error: "write failed",
      });
      expect(next.mcpPanel.removeConfirm?.error).toBe("write failed");
      expect(next.mcpPanel.removeConfirm?.submitting).toBe(false);
    });

    it("mcp_remove_succeeded closes the confirm modal", () => {
      let s = createInitialTuiState();
      s = dispatch(s, { type: "mcp_remove_confirm_opened", name: "x" });
      const next = dispatch(s, {
        type: "mcp_remove_succeeded",
        name: "x",
      });
      expect(next.mcpPanel.removeConfirm).toBeNull();
    });

    it("mcp_remove_confirm_closed clears the modal", () => {
      let s = createInitialTuiState();
      s = dispatch(s, { type: "mcp_remove_confirm_opened", name: "x" });
      const next = dispatch(s, { type: "mcp_remove_confirm_closed" });
      expect(next.mcpPanel.removeConfirm).toBeNull();
    });

    it("submit/fail actions are no-ops when the modal is closed", () => {
      const s = createInitialTuiState();
      const a = dispatch(s, { type: "mcp_remove_submitting_started" });
      const b = dispatch(a, { type: "mcp_remove_failed", error: "x" });
      expect(b.mcpPanel.removeConfirm).toBeNull();
    });
  });
});
