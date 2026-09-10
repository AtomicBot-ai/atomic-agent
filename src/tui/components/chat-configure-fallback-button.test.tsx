import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { MouseProvider } from "../mouse/mouse-context.js";
import { MouseTargetRegistry } from "../mouse/mouse-registry.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import {
  CONFIGURE_FALLBACK_ACTIONS,
  ChatConfigureFallbackButton,
} from "./chat-configure-fallback-button.js";

describe("the configure-fallback button", () => {
  it("lands the operator on the Fallback pane, in one click", () => {
    const dispatched: TuiAction[] = [];
    const registry = new MouseTargetRegistry();
    const { unmount } = render(
      <MouseProvider
        value={{
          registry,
          dispatch: (a: TuiAction) => dispatched.push(a),
          getState: () => createInitialTuiState(fakeSession()),
          callbacks: {} as TuiAppCallbacks,
        }}
      >
        <ChatConfigureFallbackButton />
      </MouseProvider>,
    );
    // The component's own contract: the three dispatches that deep-link
    // to Manage > LLM > Fallback, in order.
    expect(CONFIGURE_FALLBACK_ACTIONS.map((a) => a.type)).toEqual([
      "ui_mode_set",
      "tab_changed",
      "llm_mode_set",
    ]);
    expect(CONFIGURE_FALLBACK_ACTIONS[2]).toMatchObject({ mode: "fallback" });
    expect(CONFIGURE_FALLBACK_ACTIONS[1]).toMatchObject({ tab: "llm" });
    unmount();
  });

  it("still renders the label without a mouse provider", () => {
    const { lastFrame, unmount } = render(<ChatConfigureFallbackButton />);
    expect(lastFrame()).toContain("[configure fallback]");
    unmount();
  });
});
