import { describe, expect, it, vi } from "vitest";

import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { runComposerSwitchRow } from "./composer-switch-activate.js";
import {
  cloudState,
  fusionState,
  localModelDef,
  localState,
} from "./composer-switch-fixtures.js";
import { selectComposerSwitchRows } from "./composer-switch-rows.js";
import type { ComposerSwitchKind } from "./composer-switch-state.js";

function harness(state: TuiState) {
  const actions: TuiAction[] = [];
  const callbacks = {
    onRunModeChangeRequested: vi.fn(),
    onProvidersSetActiveText: vi.fn(),
    onProvidersSelectChatModel: vi.fn(),
    onLocalModelsSetActiveRequested: vi.fn(),
    onLocalModelsUseManagedRequested: vi.fn(),
    onLocalModelsDaemonStartRequested: vi.fn(),
    onLocalModelsDaemonStopRequested: vi.fn(),
    onFusionWorkersChangeRequested: vi.fn(),
  } as unknown as TuiAppCallbacks & {
    onRunModeChangeRequested: ReturnType<typeof vi.fn>;
    onFusionWorkersChangeRequested: ReturnType<typeof vi.fn>;
    onLocalModelsDaemonStartRequested: ReturnType<typeof vi.fn>;
    onProvidersSetActiveText: ReturnType<typeof vi.fn>;
    onProvidersSelectChatModel: ReturnType<typeof vi.fn>;
    onLocalModelsSetActiveRequested: ReturnType<typeof vi.fn>;
    onLocalModelsUseManagedRequested: ReturnType<typeof vi.fn>;
  };
  const pick = (kind: ComposerSwitchKind, label: string): void => {
    const row = selectComposerSwitchRows(state, kind).find(
      (candidate) => candidate.label === label,
    );
    if (!row) throw new Error(`no ${kind} row labelled ${label}`);
    runComposerSwitchRow(
      row,
      state,
      (action) => actions.push(action),
      callbacks,
    );
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
    expect(
      app.callbacks.onLocalModelsSetActiveRequested,
    ).not.toHaveBeenCalled();
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

  it("local with nothing downloaded still writes mode: managed", () => {
    // Regression: this branch has no model to set active, and set-active
    // was the only writer of `localModels.mode` — so the config kept
    // saying `external` and the control mislabelled the route `custom`.
    const app = harness(cloudState());
    app.pick("backend", "local");
    expect(app.callbacks.onLocalModelsUseManagedRequested).toHaveBeenCalled();
  });

  it("local with a downloaded model leaves the mode write to set-active", () => {
    const app = harness(localState("external"));
    app.pick("backend", "local");
    // `onLocalModelsSetActiveRequested` persists `mode: "managed"`
    // itself; a second writer racing it would be redundant at best.
    expect(
      app.callbacks.onLocalModelsUseManagedRequested,
    ).not.toHaveBeenCalled();
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

describe("the download deep link", () => {
  it("sends the operator to Manage › LLM › Local", () => {
    const app = harness(localState());
    app.pick("model", "Download more models…");
    expect(app.actions.map((action) => action.type)).toEqual([
      "composer_switch_closed",
      "ui_mode_set",
      "tab_changed",
      "llm_mode_set",
    ]);
    expect(app.actions.at(-1)).toEqual({ type: "llm_mode_set", mode: "local" });
  });
});

describe("picking fusion", () => {
  it("refuses with the pre-flight line when no cloud provider has a key", () => {
    const app = harness(localState());
    app.pick("backend", "fusion");
    expect(app.callbacks.onRunModeChangeRequested).not.toHaveBeenCalled();
    expect(app.actions).toContainEqual({
      type: "composer_notice",
      text: expect.stringMatching(/needs a cloud provider with a key/),
    });
  });

  it("refuses when nothing is downloaded for the workers", () => {
    const base = cloudState();
    const state = {
      ...base,
      localModelsPanel: {
        ...base.localModelsPanel,
        rows: [],
        lastRefreshedAt: 1,
      },
    };
    const app = harness(state);
    app.pick("backend", "fusion");
    expect(app.callbacks.onRunModeChangeRequested).not.toHaveBeenCalled();
    expect(app.actions).toContainEqual({
      type: "composer_notice",
      text: expect.stringMatching(/needs a downloaded local model/),
    });
  });

  it("hands a ready state to the run-mode orchestrator and nothing else", () => {
    const app = harness(fusionState({ stored: null, effective: "cloud" }));
    app.pick("backend", "fusion");
    expect(app.callbacks.onRunModeChangeRequested).toHaveBeenCalledWith(
      "fusion",
    );
    expect(app.callbacks.onProvidersSetActiveText).not.toHaveBeenCalled();
    expect(app.actions.map((action) => action.type)).toEqual([
      "composer_switch_closed",
    ]);
  });
});

describe("leaving fusion", () => {
  it("cloud clears the stored mode through the run-mode write, not set-active", () => {
    const app = harness(fusionState());
    app.pick("backend", "cloud");
    expect(app.callbacks.onRunModeChangeRequested).toHaveBeenCalledWith(
      "cloud",
    );
    expect(app.callbacks.onProvidersSetActiveText).not.toHaveBeenCalled();
  });

  it("local clears the stored mode the same way, then picks the model as before", () => {
    const app = harness(fusionState());
    app.pick("backend", "local");
    expect(app.callbacks.onRunModeChangeRequested).toHaveBeenCalledWith(
      "local",
    );
    // The model pick still goes through `triggerLlmPrimary`, whose own
    // set-active call is a redundant write of the same provider — not a
    // second mode. What must not happen is the mode write being skipped.
    expect(app.callbacks.onRunModeChangeRequested).toHaveBeenCalledTimes(1);
  });

  it("off fusion, cloud and local keep going through set-active", () => {
    const app = harness(cloudState({ isActiveText: false }));
    app.pick("backend", "cloud");
    expect(app.callbacks.onRunModeChangeRequested).not.toHaveBeenCalled();
    expect(app.callbacks.onProvidersSetActiveText).toHaveBeenCalledWith(
      "openrouter",
    );
  });
});

describe("the fusion configurators", () => {
  it("picks a worker model through the local-models orchestrator, never the text provider", () => {
    const base = fusionState();
    const state = {
      ...base,
      localModelsPanel: {
        ...base.localModelsPanel,
        rows: [
          ...base.localModelsPanel.rows.map((row) => ({
            ...row,
            active: false,
          })),
          {
            id: "qwen-3.5-9b" as never,
            def: localModelDef("qwen-3.5-9b"),
            downloaded: true,
            active: true,
            mmprojStatus: "n/a" as const,
          },
        ],
      },
    };
    const app = harness(state);
    app.pick("workers", "qwen-3.5-4b");
    // Its own writer touches `localModels.*` only, so fusion survives.
    expect(app.callbacks.onLocalModelsSetActiveRequested).toHaveBeenCalledWith(
      "qwen-3.5-4b",
    );
    expect(app.callbacks.onProvidersSetActiveText).not.toHaveBeenCalled();
    expect(app.callbacks.onRunModeChangeRequested).not.toHaveBeenCalled();
  });

  it("starts the daemon when the picked model is already the live one but nothing is serving", () => {
    const base = fusionState();
    const state = {
      ...base,
      localModelsPanel: {
        ...base.localModelsPanel,
        daemon: { ...base.localModelsPanel.daemon, running: false },
      },
    };
    const app = harness(state);
    app.pick("workers", "qwen-3.5-4b");
    expect(app.callbacks.onLocalModelsDaemonStartRequested).toHaveBeenCalled();
    expect(
      app.callbacks.onLocalModelsSetActiveRequested,
    ).not.toHaveBeenCalled();
  });

  it("does nothing when the picked model is already live and serving", () => {
    const app = harness(fusionState());
    app.pick("workers", "qwen-3.5-4b");
    expect(
      app.callbacks.onLocalModelsSetActiveRequested,
    ).not.toHaveBeenCalled();
    expect(
      app.callbacks.onLocalModelsDaemonStartRequested,
    ).not.toHaveBeenCalled();
  });

  it("offers no worker count to pick at all", () => {
    // v63: the count left the composer. The machine sizes the slot pool
    // (`managed.parallel: "auto"`) and the orchestrator sizes each
    // fan-out inside it, so there is nothing here for a person to set.
    const app = harness(fusionState());
    expect(() => app.pick("workers", "4 workers")).toThrow();
    expect(app.callbacks.onFusionWorkersChangeRequested).not.toHaveBeenCalled();
  });

  it("re-pins the orchestrator when a provider is picked under fusion", () => {
    const app = harness(fusionState());
    app.pick("provider", "openrouter");
    expect(app.callbacks.onRunModeChangeRequested).toHaveBeenCalledWith(
      "fusion",
      {
        fusion: { orchestratorProvider: "openrouter" },
      },
    );
    // Not `setActiveText`: that would move the active provider away from
    // the pin and drop the mode on the next read.
    expect(app.callbacks.onProvidersSetActiveText).not.toHaveBeenCalled();
  });

  it("still opens the wizard for a keyless provider under fusion", () => {
    const app = harness(fusionState());
    app.pick("provider", "aimlapi");
    expect(app.callbacks.onRunModeChangeRequested).not.toHaveBeenCalled();
    expect(app.actions).toContainEqual(
      expect.objectContaining({ type: "providers_wizard_opened" }),
    );
  });
});
