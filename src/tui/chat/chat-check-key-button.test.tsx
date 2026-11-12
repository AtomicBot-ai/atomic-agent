import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { providerRow } from "../composer-switch/composer-switch-fixtures.js";
import type { ProviderRow } from "../providers/providers-panel-state.js";
import type { TuiAction } from "../tui-action.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import { ChatCheckKeyButton, dispatchCheckKey } from "./chat-check-key-button.js";

function stateWith(rows: ProviderRow[]): TuiState {
  const base = createInitialTuiState(fakeSession());
  return { ...base, providersPanel: { ...base.providersPanel, rows } };
}

function clicked(state: TuiState, providerId: string | undefined): TuiAction[] {
  const out: TuiAction[] = [];
  dispatchCheckKey(state, (a) => out.push(a), providerId);
  return out;
}

describe("the check-key button", () => {
  it("opens the provider that refused the key, on its key step", () => {
    const actions = clicked(
      stateWith([
        providerRow({ id: "gemini", kind: "gemini", isActiveText: true }),
        providerRow({ id: "openrouter", kind: "openrouter" }),
      ]),
      "openrouter",
    );
    expect(actions.slice(0, 3)).toEqual([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "llm" },
      { type: "llm_mode_set", mode: "cloud" },
    ]);
    const opened = actions[3];
    expect(opened?.type).toBe("providers_wizard_opened");
    if (opened?.type !== "providers_wizard_opened") return;
    expect(opened.wizard.mode).toBe("configure");
    expect(opened.wizard.providerId).toBe("openrouter");
    expect(opened.wizard.phase).toBe("api_key");
  });

  it("falls back to the active cloud provider when the error named none", () => {
    const actions = clicked(
      stateWith([
        providerRow({ id: "openrouter", kind: "openrouter" }),
        providerRow({ id: "gemini", kind: "gemini", isActiveText: true }),
      ]),
      undefined,
    );
    const opened = actions[3];
    expect(opened?.type).toBe("providers_wizard_opened");
    if (opened?.type !== "providers_wizard_opened") return;
    expect(opened.wizard.providerId).toBe("gemini");
  });

  it("lands on the Cloud pane alone when no provider can be configured", () => {
    const actions = clicked(stateWith([]), "openrouter");
    expect(actions.map((a) => a.type)).toEqual([
      "ui_mode_set",
      "tab_changed",
      "llm_mode_set",
    ]);
  });

  it("shows the /llm hint without a mouse provider", () => {
    const { lastFrame, unmount } = render(<ChatCheckKeyButton providerId="openrouter" />);
    expect(lastFrame()).toContain("/llm");
    unmount();
  });
});
