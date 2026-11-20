import type { Key } from "ink";
import { describe, expect, it } from "vitest";

import { handleImportFactsKey } from "./import-facts-keys.js";
import type { ImportFactsCommand } from "./import-facts-runner.js";
import { createInitialImportFactsState, type ImportFactsUiState } from "./import-facts-state.js";

const key = (k: Partial<Key> = {}): Key => k as Key;

function drive(s: Partial<ImportFactsUiState>) {
  const actions: unknown[] = [];
  const cmds: ImportFactsCommand[] = [];
  const state = { ...createInitialImportFactsState(), ...s };
  return {
    actions,
    cmds,
    press: (input: string, k: Partial<Key> = {}) => handleImportFactsKey(input, key(k), state, (a) => actions.push(a), (c) => cmds.push(c)),
  };
}

describe("facts step keys (ATO-1627)", () => {
  it("Enter on Find facts starts with the form's choices, local unless ticked", () => {
    const d = drive({ focus: "start", kind: "chatgpt", path: "~/x.zip", cloudProvider: "openrouter" });
    d.press("", { return: true });
    expect(d.cmds).toEqual([{ kind: "start", facts: { kind: "chatgpt", path: "~/x.zip", cloud: false, cloudProvider: "openrouter" } }]);
  });

  it("Esc while running stops the job", () => {
    const d = drive({ phase: "running", jobId: "j1" });
    d.press("", { escape: true });
    expect(d.cmds).toEqual([{ kind: "stop", jobId: "j1" }]);
  });

  it("review: space toggles, Enter saves exactly the ticked ids, Esc discards", () => {
    const d = drive({ phase: "review", jobId: "j1", checked: ["c0-0"] });
    d.press(" ");
    expect(d.actions).toEqual([{ type: "import_facts_checked_toggled" }]);
    d.press("", { return: true });
    expect(d.cmds).toEqual([{ kind: "save", jobId: "j1", approvedIds: ["c0-0"] }]);
    d.press("", { escape: true });
    expect(d.cmds[1]).toEqual({ kind: "close", jobId: "j1" });
  });

  it("types into the path and consumes every key", () => {
    const d = drive({ focus: "path" });
    expect(d.press("a")).toBe(true);
    expect(d.actions).toEqual([{ type: "import_facts_path_edited", text: "a", backspace: false }]);
  });
});
