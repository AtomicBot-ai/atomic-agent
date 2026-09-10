import { describe, expect, it } from "vitest";

import { reduceTuiState } from "../agent-event-reducer.js";
import { reduceIntegrationsAction } from "../integrations/integrations-panel-reducer.js";
import { createInitialIntegrationsPanelState } from "../integrations/integrations-panel-state.js";
import { createInitialTuiState, type TuiSessionInfo, type TuiState } from "../tui-state.js";

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

describe("the download notify prompt", () => {
  it("opens with its label and remembered answer, and closes", () => {
    let state = createInitialTuiState(SESSION);
    expect(state.localModelsPanel.notifyPrompt).toBeNull();
    state = reduceTuiState(state, {
      type: "local_models_notify_prompt_opened",
      prompt: { label: "Qwen 3.5 4B", current: "discord" },
    });
    expect(state.localModelsPanel.notifyPrompt).toEqual({ label: "Qwen 3.5 4B", current: "discord" });
    state = reduceTuiState(state, { type: "local_models_notify_prompt_closed" });
    expect(state.localModelsPanel.notifyPrompt).toBeNull();
  });
});

describe("integrations_selected", () => {
  function stateWith(rows: string[], selected = 0): TuiState {
    return {
      integrationsPanel: {
        ...createInitialIntegrationsPanelState(),
        rows: rows.map((id) => ({
          id,
          label: id,
          summary: "",
          level: "not_configured" as const,
          appliesLive: false,
          fields: [],
          actions: [],
        })),
        selected,
        mode: "detail" as const,
        selectedField: 2,
      },
    } as unknown as TuiState;
  }

  it("lands the cursor on the named integration, back in list mode", () => {
    const next = reduceIntegrationsAction(stateWith(["composio", "telegram", "discord"]), {
      type: "integrations_selected",
      id: "discord",
    });
    expect(next?.integrationsPanel).toMatchObject({ selected: 2, selectedField: 0, mode: "list" });
  });

  it("ignores an id that is not on the list", () => {
    const state = stateWith(["composio"], 0);
    const next = reduceIntegrationsAction(state, { type: "integrations_selected", id: "fax" });
    expect(next).toBe(state);
  });
});
