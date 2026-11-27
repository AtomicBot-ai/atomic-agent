import type { Key } from "ink";
import { describe, expect, it } from "vitest";

import type { DetectedLocalServer } from "../../llm/provider/presets/detect-local-servers.js";
import { arrowKey, returnKey } from "../mouse/synthetic-key.js";
import { fakeSession } from "../test-fixtures.js";
import { createInitialTuiState } from "../tui-state.js";
import { withDetectedLocal } from "./apply-detected-local.js";
import { detectedRowLabel, orderKindOptionsForDetected } from "./detected-kind-rows.js";
import { reduceProvidersPanel } from "./providers-reducer.js";
import { handleProvidersWizardKey } from "./providers-wizard-key-bindings.js";
import { KIND_OPTIONS, visibleKindRows } from "./providers-wizard-phases.js";
import { createProvidersWizardState } from "./providers-wizard-state.js";

const OLLAMA: DetectedLocalServer = {
  kind: "ollama",
  label: "Ollama",
  baseUrl: "http://127.0.0.1:11434",
  presetId: "ollama",
  models: ["qwen3:8b", "gemma3:4b", "llama3.2"],
  loaded: ["qwen3:8b"],
};
const LMSTUDIO: DetectedLocalServer = {
  kind: "lmstudio",
  label: "LM Studio",
  baseUrl: "http://127.0.0.1:1234",
  presetId: "lmstudio",
  models: ["qwen/qwen3-8b"],
  loaded: [],
};
const LLAMA_APP: DetectedLocalServer = {
  kind: "llama-app",
  label: "Llama app (llama.cpp)",
  baseUrl: "http://127.0.0.1:9931",
  presetId: null,
  models: ["gemma-3-4b-it"],
  loaded: [],
};

function presetIdOf(row: (typeof KIND_OPTIONS)[number]["row"]): string | null {
  return typeof row === "object" ? row.presetId : null;
}

function escKey(): Key {
  return { ...returnKey(), return: false, escape: true };
}

describe("orderKindOptionsForDetected", () => {
  it("leaves the list alone when nothing runs here", () => {
    expect(orderKindOptionsForDetected(KIND_OPTIONS, undefined)).toBe(KIND_OPTIONS);
    expect(orderKindOptionsForDetected(KIND_OPTIONS, [])).toBe(KIND_OPTIONS);
    // llama.cpp is not a provider preset, so it never lifts a row.
    expect(orderKindOptionsForDetected(KIND_OPTIONS, [LLAMA_APP])).toBe(KIND_OPTIONS);
  });

  it("puts the running servers first, in detection order, without duplicates", () => {
    const rows = orderKindOptionsForDetected(KIND_OPTIONS, [OLLAMA, LMSTUDIO]);
    expect(rows).toHaveLength(KIND_OPTIONS.length);
    expect(presetIdOf(rows[0]!.row)).toBe("ollama");
    expect(presetIdOf(rows[1]!.row)).toBe("lmstudio");
    expect(rows.filter((r) => presetIdOf(r.row) === "ollama")).toHaveLength(1);
    expect(rows.filter((r) => presetIdOf(r.row) === "lmstudio")).toHaveLength(1);
    expect(rows[0]!.label).toBe("Ollama (local) · running here: 3 models, 1 loaded");
    expect(rows[1]!.label).toBe("LM Studio (local) · running here: 1 model");
    // The rest keep their order.
    const rest = KIND_OPTIONS.filter(
      (r) => presetIdOf(r.row) !== "ollama" && presetIdOf(r.row) !== "lmstudio",
    );
    expect(rows.slice(2)).toEqual(rest);
  });

  it("is what the search box filters", () => {
    const rows = visibleKindRows("running", [OLLAMA]);
    expect(rows.map((r) => r.id)).toEqual(["ollama"]);
  });

  it("labels a server with no models", () => {
    expect(detectedRowLabel("Ollama (local)", { ...OLLAMA, models: [], loaded: [] })).toBe(
      "Ollama (local) · running here: 0 models",
    );
  });
});

describe("wizard with detected servers", () => {
  it("Enter on the first row picks the detected server's preset", () => {
    const wizard = { ...createProvidersWizardState("add"), detectedLocal: [OLLAMA] };
    const result = handleProvidersWizardKey("", returnKey(), wizard);
    expect(result).toMatchObject({
      handled: true,
      wizard: { kind: "openai-compatible", presetId: "ollama", phase: "chat_model_line" },
    });
  });

  it("without detection the first row is still the first built-in row", () => {
    const result = handleProvidersWizardKey("", returnKey(), createProvidersWizardState("add"));
    expect(result).toMatchObject({ handled: true });
    expect("wizard" in result && result.wizard.presetId).not.toBe("ollama");
  });

  it("Esc from the picked preset returns to its row on top, keeping the detection", () => {
    const wizard = { ...createProvidersWizardState("add"), detectedLocal: [OLLAMA] };
    const picked = handleProvidersWizardKey("", returnKey(), wizard);
    if (!("wizard" in picked)) throw new Error("expected a wizard");
    const back = handleProvidersWizardKey("", escKey(), picked.wizard);
    expect(back).toMatchObject({
      handled: true,
      wizard: { phase: "pick_kind", cursor: 0, detectedLocal: [OLLAMA] },
    });
  });
});

describe("withDetectedLocal", () => {
  it("keeps an untouched cursor on the first row, now the detected server", () => {
    const next = withDetectedLocal(createProvidersWizardState("add"), [LMSTUDIO]);
    expect(next.cursor).toBe(0);
    expect(next.detectedLocal).toEqual([LMSTUDIO]);
    expect(presetIdOf(visibleKindRows(null, next.detectedLocal)[0]!.row)).toBe("lmstudio");
  });

  it("keeps a moved cursor on the row it was on", () => {
    const start = createProvidersWizardState("add");
    const moved = handleProvidersWizardKey("", arrowKey("down"), start);
    if (!("wizard" in moved)) throw new Error("expected a wizard");
    const before = visibleKindRows(null, undefined)[moved.wizard.cursor]!.row;
    const next = withDetectedLocal(moved.wizard, [OLLAMA]);
    expect(visibleKindRows(null, next.detectedLocal)[next.cursor]!.row).toBe(before);
  });

  it("ignores an empty answer", () => {
    const wizard = createProvidersWizardState("add");
    expect(withDetectedLocal(wizard, [])).toBe(wizard);
  });
});

describe("providers_wizard_local_detected", () => {
  it("folds the servers into the open wizard", () => {
    const base = createInitialTuiState(fakeSession(), 50);
    const state = {
      ...base,
      providersPanel: { ...base.providersPanel, wizard: createProvidersWizardState("add") },
    };
    const next = reduceProvidersPanel(state, {
      type: "providers_wizard_local_detected",
      servers: [OLLAMA],
    } as { type: string });
    expect(next?.providersPanel.wizard?.detectedLocal).toEqual([OLLAMA]);
  });

  it("does nothing when no wizard is open", () => {
    const state = createInitialTuiState(fakeSession(), 50);
    const next = reduceProvidersPanel(state, {
      type: "providers_wizard_local_detected",
      servers: [OLLAMA],
    } as { type: string });
    expect(next).toBe(state);
  });
});
