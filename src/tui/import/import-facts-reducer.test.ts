import { describe, expect, it } from "vitest";

import type { FactCandidate } from "../../memory/import-facts/index.js";
import { createInitialImportPanelState } from "./import-panel-state.js";
import { reduceImportFacts } from "./import-facts-reducer.js";
import { createInitialImportFactsState, importFactsModelLine } from "./import-facts-state.js";
import { reduceImportAction } from "./import-reducer.js";
import type { TuiState } from "../tui-state.js";

const CANDIDATES: FactCandidate[] = [
  { id: "c0-0", kind: "profile", key: "job", value: "designer", pinned: true, chatId: "a", quote: "I'm a designer" },
  { id: "c0-1", kind: "note", key: null, value: "Builds a portfolio site", pinned: false, chatId: "a", quote: "my portfolio" },
];

describe("facts step reducer (ATO-1627)", () => {
  it("opens and closes the step through the Import slice", () => {
    const state = { importPanel: createInitialImportPanelState() } as TuiState;
    const opened = reduceImportAction(state, { type: "import_facts_opened", localLabel: "local-llama", cloudProvider: null } as never)!;
    expect(opened.importPanel.mode).toBe("facts");
    expect(opened.importPanel.facts.localLabel).toBe("local-llama");
    const closed = reduceImportAction(opened, { type: "import_facts_closed" } as never)!;
    expect(closed.importPanel.mode).toBe("configure");
  });

  it("ticks every candidate by default; space unticks the one under the cursor", () => {
    let s = reduceImportFacts(createInitialImportFactsState(), { type: "import_facts_found", candidates: CANDIDATES, stopped: false });
    expect(s.phase).toBe("review");
    expect(s.checked).toEqual(["c0-0", "c0-1"]);
    s = reduceImportFacts(s, { type: "import_facts_cursor_moved", delta: 1 });
    s = reduceImportFacts(s, { type: "import_facts_checked_toggled" });
    expect(s.checked).toEqual(["c0-0"]);
    s = reduceImportFacts(s, { type: "import_facts_cursor_moved", delta: 5 });
    expect(s.cursor).toBe(1);
  });

  it("a failure goes back to the form with the reason; the path survives", () => {
    let s = reduceImportFacts(createInitialImportFactsState(), { type: "import_facts_path_edited", text: "/tmp/x.zip", backspace: false });
    s = reduceImportFacts(s, { type: "import_facts_started", jobId: "j", providerId: "local-llama", local: true });
    s = reduceImportFacts(s, { type: "import_facts_failed", error: "no conversations.json" });
    expect(s).toMatchObject({ phase: "form", path: "/tmp/x.zip", error: "no conversations.json", jobId: null });
  });

  it("the model line says where the text goes", () => {
    expect(importFactsModelLine({ cloud: false, localLabel: "local-llama", cloudProvider: "openrouter" })).toMatch(/local model/);
    expect(importFactsModelLine({ cloud: true, localLabel: "local-llama", cloudProvider: "openrouter" })).toMatch(/sent to openrouter/);
    expect(importFactsModelLine({ cloud: false, localLabel: null, cloudProvider: null })).toMatch(/no local model/);
  });
});
