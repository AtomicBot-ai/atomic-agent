import { describe, expect, it, vi } from "vitest";

import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { runComposerSwitchRow } from "./composer-switch-activate.js";
import { cloudState, localState } from "./composer-switch-fixtures.js";
import { selectComposerSwitchRows } from "./composer-switch-rows.js";
import type { ComposerSwitchKind } from "./composer-switch-state.js";

function harness(state: TuiState) {
  const actions: TuiAction[] = [];
  const callbacks = {
    onProvidersSetActiveText: vi.fn(),
    onProvidersSelectChatModel: vi.fn(),
    onLocalModelsSetActiveRequested: vi.fn(),
    onLocalModelsDaemonStartRequested: vi.fn(),
    onLocalModelsDaemonStopRequested: vi.fn(),
  } as unknown as TuiAppCallbacks & {
    onProvidersSetActiveText: ReturnType<typeof vi.fn>;
    onProvidersSelectChatModel: ReturnType<typeof vi.fn>;
    onLocalModelsSetActiveRequested: ReturnType<typeof vi.fn>;
  };
  const pick = (kind: ComposerSwitchKind, label: string): void => {
    const row = selectComposerSwitchRows(state, kind).find(
      (candidate) => candidate.label === label,
    );
    if (!row) throw new Error(`no ${kind} row labelled ${label}`);
    runComposerSwitchRow(row, state, (action) => actions.push(action), callbacks);
  };
  return { actions, callbacks, pick };
}

/**
 * The point of these cases is negative as much as positive: nothing here
 * may reach the provider registry or config on its own. Every selection
 * has to land on the callback `ProvidersOrchestrator` already listens
 * on, which is what keeps one implementation of "switch the route".
 */
describe("picking a provider", () => {
  it("goes through the orchestrator's set-active callback", () => {
    const app = harness(cloudState({ id: "openrouter", isActiveText: false }));
    app.pick("provider", "aimlapi");
    // aimlapi has no key in the fixture, so its row configures instead —
    // the same decision `cloudProviderRow` makes for the LLM tab.
    expect(app.actions).toContainEqual(
      expect.objectContaining({ type: "providers_wizard_opened" }),
    );
    expect(app.callbacks.onProvidersSetActiveText).not.toHaveBeenCalled();
  });

  it("activates a provider that has credentials", () => {
    const app = harness(cloudState({ isActiveText: false }));
    app.pick("provider", "openrouter");
    expect(app.callbacks.onProvidersSetActiveText).toHaveBeenCalledWith(
      "openrouter",
    );
  });

  it("opens the wizard for the add entry", () => {
    const app = harness(cloudState());
    app.pick("provider", "Add a new provider");
    expect(app.actions.map((action) => action.type)).toEqual([
      "composer_switch_closed",
      "ui_mode_set",
      "tab_changed",
      "llm_mode_set",
      "providers_wizard_opened",
    ]);
  });
});

describe("picking a model", () => {
  it("goes through the orchestrator's select-chat-model callback", () => {
    const app = harness(cloudState());
    app.pick("model", "qwen/qwen3.7-max");
    expect(app.callbacks.onProvidersSelectChatModel).toHaveBeenCalledWith(
      "openrouter",
      "qwen/qwen3.7-max",
    );
  });

  it("uses the local-models callbacks for a local model", () => {
    const app = harness(localState());
    app.pick("model", "qwen-3.5-4b");
    // Already active with a live daemon: the row's primary action is
    // `current`, so nothing is re-selected and nothing is restarted.
    expect(app.callbacks.onLocalModelsSetActiveRequested).not.toHaveBeenCalled();
  });

  it("re-selects the model when local is picked out of custom mode", () => {
    // The set-active call is the only writer of `localModels.mode:
    // managed`, and the row is already active, so `triggerLlmPrimary`
    // alone would leave the route reading `custom`.
    const app = harness(localState("external"));
    app.pick("backend", "local");
    expect(app.callbacks.onLocalModelsSetActiveRequested).toHaveBeenCalledWith(
      "qwen-3.5-4b",
    );
  });
});

describe("picking a backend", () => {
  it("cloud routes to the provider that can serve it", () => {
    const app = harness(localState());
    app.pick("backend", "cloud");
    // The fixture's only provider is the local one, so there is no cloud
    // route to switch to and the wizard is the honest answer.
    expect(app.actions).toContainEqual(
      expect.objectContaining({ type: "providers_wizard_opened" }),
    );
  });

  it("cloud activates the keyed provider when there is one", () => {
    const app = harness(cloudState({ isActiveText: false }));
    app.pick("backend", "cloud");
    expect(app.callbacks.onProvidersSetActiveText).toHaveBeenCalledWith(
      "openrouter",
    );
  });

  it("local points the route at llama.cpp through the same callback", () => {
    const app = harness(cloudState());
    app.pick("backend", "local");
    expect(app.callbacks.onProvidersSetActiveText).toHaveBeenCalledWith(
      "local-llama",
    );
    // Nothing is downloaded in the cloud fixture, so the model switch
    // reopens rather than a multi-gigabyte pull starting itself.
    expect(app.actions).toContainEqual({
      type: "composer_switch_opened",
      kind: "model",
    });
  });

  it("custom opens the external base-URL editor where it is drawn", () => {
    const app = harness(cloudState());
    app.pick("backend", "custom");
    expect(app.actions.map((action) => action.type)).toEqual([
      "composer_switch_closed",
      "ui_mode_set",
      "tab_changed",
      "llm_mode_set",
      "llm_external_url_draft_set",
    ]);
    expect(app.actions.at(-1)).toEqual({
      type: "llm_external_url_draft_set",
      value: "http://127.0.0.1:8080",
    });
  });
});
