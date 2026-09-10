import type { Key } from "ink";
import { describe, expect, it } from "vitest";

import { arrowKey, plainKey, returnKey } from "../mouse/synthetic-key.js";
import { fakeSession } from "../test-fixtures.js";
import type { TuiAction } from "../tui-action.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { handleImportTabKey } from "./import-key-bindings.js";
import type { ImportFormState } from "./import-panel-state.js";

function sideKey(direction: "left" | "right"): Key {
  return {
    ...plainKey(),
    leftArrow: direction === "left",
    rightArrow: direction === "right",
  };
}

function stateWith(form: Partial<ImportFormState>): TuiState {
  const base = createInitialTuiState(fakeSession());
  return {
    ...base,
    uiMode: "debug",
    activeTab: "import",
    importPanel: {
      ...base.importPanel,
      form: { ...base.importPanel.form, ...form },
    },
  };
}

function drive(state: TuiState) {
  const actions: TuiAction[] = [];
  const previews: ImportFormState[] = [];
  const handle = (input: string, key: Key) =>
    handleImportTabKey(input, key, {
      state,
      dispatch: (action) => actions.push(action),
      callbacks: { onImportPreview: (form) => previews.push(form) },
    });
  return { actions, previews, handle };
}

describe("handleImportTabKey — source type row", () => {
  it("cycles forward with → / space / Enter and back with ←", () => {
    const { actions, handle } = drive(
      stateWith({ focus: "sourceType", source: "openclaw" }),
    );
    expect(handle("", sideKey("right"))).toBe(true);
    expect(handle(" ", plainKey())).toBe(true);
    expect(handle("", returnKey())).toBe(true);
    expect(handle("", sideKey("left"))).toBe(true);
    expect(actions).toEqual([
      { type: "import_source_set", source: "claude-code" },
      { type: "import_source_set", source: "claude-code" },
      { type: "import_source_set", source: "claude-code" },
      { type: "import_source_set", source: "hermes" },
    ]);
  });

  it("reaches codex and wraps back to hermes", () => {
    const { actions, handle } = drive(
      stateWith({ focus: "sourceType", source: "codex" }),
    );
    handle("", sideKey("right"));
    expect(actions).toEqual([{ type: "import_source_set", source: "hermes" }]);
  });
});

describe("handleImportTabKey — focus order per source", () => {
  it("walks the Claude Code rows, skills first, and toggles them", () => {
    const { actions, handle } = drive(
      stateWith({ focus: "source", source: "claude-code" }),
    );
    handle("", arrowKey("down"));
    expect(actions).toEqual([{ type: "import_focus_set", focus: "skills" }]);

    const mcp = drive(stateWith({ focus: "mcp", source: "claude-code" }));
    mcp.handle(" ", plainKey());
    mcp.handle("", arrowKey("down"));
    expect(mcp.actions).toEqual([
      { type: "import_toggled", field: "mcp" },
      { type: "import_focus_set", focus: "sessions" },
    ]);
  });

  it("has no mcp or cron row for Codex", () => {
    const { actions, handle } = drive(
      stateWith({ focus: "memory", source: "codex" }),
    );
    handle("", arrowKey("down"));
    expect(actions).toEqual([{ type: "import_focus_set", focus: "sessions" }]);
  });

  it("still runs the preview from the run row", () => {
    const { previews, handle } = drive(
      stateWith({ focus: "run", source: "codex" }),
    );
    handle("", returnKey());
    expect(previews).toHaveLength(1);
    expect(previews[0]!.source).toBe("codex");
  });
});
