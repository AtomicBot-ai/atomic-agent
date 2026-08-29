import type { Key } from "ink";
import { describe, expect, it, vi } from "vitest";

import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { createInitialTuiState } from "../tui-state.js";
import { handleProvidersTabKey } from "./providers-key-bindings.js";
import type { ProviderRow } from "./providers-panel-state.js";

function emptyKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  };
}

function row(overrides: Partial<ProviderRow>): ProviderRow {
  return {
    id: "x",
    kind: "openrouter",
    isActiveText: false,
    isActiveEmbedding: false,
    hasApiKey: true,
    baseUrl: null,
    subscriptionCli: null,
    chatModel: null,
    embeddingModel: null,
    ...overrides,
  };
}

/** The panel only reads `uiMode`, `activeTab` and `providersPanel`. */
function stateWith(rows: readonly ProviderRow[]): TuiState {
  const base = createInitialTuiState({ id: "s1", workingDir: "/tmp" });
  return {
    ...base,
    uiMode: "debug",
    activeTab: "providers",
    providersPanel: { ...base.providersPanel, rows, cursor: 0 },
  };
}

function pressC(rows: readonly ProviderRow[]) {
  const dispatch = vi.fn<(action: TuiAction) => void>();
  const handled = handleProvidersTabKey("c", emptyKey(), {
    state: stateWith(rows),
    dispatch,
    callbacks: {} as TuiAppCallbacks,
  });
  return { handled, dispatch };
}

describe("handleProvidersTabKey — c on a subscription-cli row", () => {
  it("opens the configure wizard on the claude-cli row", () => {
    // The row's stored kind is `subscription-cli` for both CLIs, so only
    // the CLI name on the entry can say which wizard row to reopen.
    // Before this, `c` matched no branch, was swallowed by the handler
    // and did nothing at all.
    const { handled, dispatch } = pressC([
      row({
        id: "claude-cli",
        kind: "subscription-cli",
        subscriptionCli: { cli: "claude" },
        chatModel: "opus",
      }),
    ]);

    expect(handled).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const action = dispatch.mock.calls[0]![0] as Extract<
      TuiAction,
      { type: "providers_wizard_opened" }
    >;
    expect(action.wizard.kind).toBe("claude-cli");
    expect(action.wizard.mode).toBe("configure");
    expect(action.wizard.providerId).toBe("claude-cli");
    // Straight to the only editable field: a CLI-backed provider has no
    // key to paste, so the api_key screen would be a dead end.
    expect(action.wizard.phase).toBe("chat_model_line");
    // Prefilled, so Enter keeps the pinned model instead of resetting it.
    expect(action.wizard.chatModelLine).toBe("opus");
  });

  it("opens the codex-cli row on its own wizard kind", () => {
    const { dispatch } = pressC([
      row({
        id: "codex-cli",
        kind: "subscription-cli",
        subscriptionCli: { cli: "codex" },
      }),
    ]);

    const action = dispatch.mock.calls[0]![0] as Extract<
      TuiAction,
      { type: "providers_wizard_opened" }
    >;
    expect(action.wizard.kind).toBe("codex-cli");
    expect(action.wizard.phase).toBe("chat_model_line");
    // Codex resolves the model server-side; an empty line saves that.
    expect(action.wizard.chatModelLine).toBe("");
  });

  it("still opens key-based cloud rows on the API-key screen", () => {
    const { dispatch } = pressC([
      row({ id: "gemini", kind: "gemini", chatModel: "gemini-2.5-flash" }),
    ]);

    const action = dispatch.mock.calls[0]![0] as Extract<
      TuiAction,
      { type: "providers_wizard_opened" }
    >;
    expect(action.wizard.kind).toBe("gemini");
    expect(action.wizard.phase).toBe("api_key");
  });

  it("opens nothing on the local llama row", () => {
    const { handled, dispatch } = pressC([
      row({ id: "local-llama", kind: "llama-server", hasApiKey: false }),
    ]);

    expect(handled).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
