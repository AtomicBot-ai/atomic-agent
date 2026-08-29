import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import type { FallbackLinkRow } from "../llm-panel/fallback/fallback-panel-state.js";
import { MouseProvider } from "../mouse/mouse-context.js";
import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { MouseTargetRegistry } from "../mouse/mouse-registry.js";
import { fakeSession } from "../test-fixtures.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { FallbackRows } from "./llm-fallback-rows.js";
import { LlmModeRows } from "./llm-mode-rows.js";

function strip(value: string): string {
  return value.replace(/\[[0-9;]*m/g, "");
}

function link(providerId: string, over: Partial<FallbackLinkRow> = {}): FallbackLinkRow {
  return {
    providerId,
    modelLabel: null,
    kind: "openrouter",
    isActive: false,
    isAppendedLocal: false,
    ...over,
  };
}

function fallbackState(patch: Partial<TuiState["fallbackPanel"]> = {}): TuiState {
  const base = createInitialTuiState(fakeSession());
  return {
    ...base,
    llmPanel: { ...base.llmPanel, mode: "fallback" },
    fallbackPanel: { ...base.fallbackPanel, ...patch },
  };
}

describe("FallbackRows", () => {
  it("renders links in order with the active head marked and a numbered list", () => {
    const state = fallbackState({
      links: [
        link("cloud-a", { isActive: true, modelLabel: "vendor/a" }),
        link("cloud-b", { modelLabel: "vendor/b" }),
        link("local-llama", { kind: "llama-server", isAppendedLocal: true }),
      ],
      addableProviderIds: ["cloud-c"],
      appendLocal: true,
    });
    const { lastFrame } = render(<LlmModeRows rows={[]} state={state} maxRows={20} />);
    const out = strip(lastFrame() ?? "");
    expect(out).toContain("Fallback chain");
    // Order preserved with 1-based numbering.
    const aAt = out.indexOf("1. cloud-a");
    const bAt = out.indexOf("2. cloud-b");
    const lAt = out.indexOf("3. local-llama");
    expect(aAt).toBeGreaterThan(-1);
    expect(bAt).toBeGreaterThan(aAt);
    expect(lAt).toBeGreaterThan(bAt);
    expect(out).toContain("active (primary)");
    expect(out).toContain("local last resort (appendLocal)");
    expect(out).toContain("+ add link");
  });

  it("shows the empty-state hint when no chain is configured", () => {
    const state = fallbackState({ links: [], addableProviderIds: ["cloud-a"] });
    const { lastFrame } = render(<LlmModeRows rows={[]} state={state} maxRows={20} />);
    const out = strip(lastFrame() ?? "");
    expect(out).toContain("No chain configured");
  });

  it("still renders the add row on an empty chain (cursor row 0 is visible)", () => {
    // The row MODEL has an add row whenever something is addable, chain
    // or no chain — the renderer must agree, or the cursor sits on a row
    // the screen never drew and Enter looks like it does nothing.
    const state = fallbackState({ links: [], addableProviderIds: ["cloud-a"] });
    const { lastFrame } = render(<LlmModeRows rows={[]} state={state} maxRows={20} />);
    const out = strip(lastFrame() ?? "");
    expect(out).toContain("+ add link");
    // Cursor 0 = the add row; it renders selected.
    expect(out).toContain("> + add link");
  });

  it("renders neither hint marker nor add row when nothing is addable and no chain", () => {
    const state = fallbackState({ links: [], addableProviderIds: [] });
    const { lastFrame } = render(<LlmModeRows rows={[]} state={state} maxRows={20} />);
    const out = strip(lastFrame() ?? "");
    expect(out).toContain("No chain configured");
    expect(out).not.toContain("+ add link");
  });

  it("surfaces the last fallover as a live status line (no invented countdown)", () => {
    const state = fallbackState({
      links: [link("cloud-a", { isActive: true })],
      lastSwitch: { direction: "away", from: "cloud-a", to: "cloud-b", reason: "429" },
    });
    const { lastFrame } = render(<LlmModeRows rows={[]} state={state} maxRows={20} />);
    const out = strip(lastFrame() ?? "");
    expect(out).toContain("failed over cloud-a");
    expect(out).toContain("cloud-b");
    expect(out).not.toMatch(/retry in \d/);
  });

  it("says on primary when nothing has failed over", () => {
    const state = fallbackState({ links: [link("cloud-a", { isActive: true })] });
    const { lastFrame } = render(<LlmModeRows rows={[]} state={state} maxRows={20} />);
    expect(strip(lastFrame() ?? "")).toContain("on primary (no fallover this session)");
  });

  it("renders the add-link picker when open", () => {
    const state = fallbackState({
      links: [link("cloud-a", { isActive: true })],
      addableProviderIds: ["cloud-b", "cloud-c"],
      addPicker: { cursor: 1 },
    });
    const { lastFrame } = render(<LlmModeRows rows={[]} state={state} maxRows={20} />);
    const out = strip(lastFrame() ?? "");
    expect(out).toContain("Add fallback link");
    expect(out).toContain("cloud-b");
    expect(out).toContain("cloud-c");
  });

  it("shows the appendLocal toggle state", () => {
    const state = fallbackState({
      links: [link("cloud-a", { isActive: true })],
      appendLocal: false,
    });
    const { lastFrame } = render(<LlmModeRows rows={[]} state={state} maxRows={20} />);
    expect(strip(lastFrame() ?? "")).toContain("append local as last resort: off");
  });
});

/**
 * Click plumbing. Rendered under a real `MouseProvider` + registry, the
 * same harness as `chat-copy-button.test.tsx`: locate the row's text in
 * the frame, dispatch a press at that cell, and assert what the row
 * dispatched / which callback fired. The activation path is
 * `pressEnter(handleLlmPanelKey)`, so a click on the selected row must do
 * exactly what Enter does — no second implementation to drift.
 */
describe("FallbackRows clicks", () => {
  function press(x: number, y: number): TuiMouseEvent {
    return {
      kind: "press",
      button: "left",
      wheel: null,
      x,
      y,
      shift: false,
      alt: false,
      ctrl: false,
    };
  }

  function locate(frame: string, needle: string): { x: number; y: number } {
    for (const [y, line] of frame.split("\n").entries()) {
      const x = line.indexOf(needle);
      if (x !== -1) return { x, y };
    }
    throw new Error(`"${needle}" is not on screen:\n${frame}`);
  }

  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  /** Pane state ready for clicking: debug mode, LLM tab, fallback pane. */
  function clickableState(
    patch: Partial<TuiState["fallbackPanel"]> = {},
    cursor = 0,
  ): TuiState {
    const base = fallbackState(patch);
    return {
      ...base,
      uiMode: "debug",
      activeTab: "llm",
      llmPanel: { ...base.llmPanel, fallbackCursor: cursor },
    };
  }

  interface ClickHarness {
    frame: () => string;
    clickAt: (needle: string) => Promise<void>;
    dispatched: TuiAction[];
    calls: unknown[][];
    unmount: () => void;
  }

  function mount(state: TuiState): ClickHarness {
    const registry = new MouseTargetRegistry();
    const dispatched: TuiAction[] = [];
    const calls: unknown[][] = [];
    const callbacks: TuiAppCallbacks = {
      onFallbackAddRequested: (providerId) => calls.push(["add", providerId]),
    };
    const { lastFrame, unmount } = render(
      <MouseProvider
        registry={registry}
        dispatch={(action) => dispatched.push(action)}
        callbacks={callbacks}
        getState={() => state}
      >
        <FallbackRows state={state} />
      </MouseProvider>,
    );
    const frame = (): string => strip(lastFrame() ?? "");
    return {
      frame,
      // Targets register in an effect after the first frame, so the
      // first press can land on unowned cells — re-send until something
      // records, the same loop as the sibling click tests.
      clickAt: async (needle) => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (dispatched.length > 0 || calls.length > 0) return;
          const at = locate(frame(), needle);
          registry.dispatch(press(at.x, at.y));
          await delay(25);
        }
      },
      dispatched,
      calls,
      unmount,
    };
  }

  it("a click on an unselected chain row moves the cursor there", async () => {
    const app = mount(
      clickableState(
        {
          links: [link("cloud-a", { isActive: true }), link("cloud-b")],
          addableProviderIds: ["cloud-c"],
        },
        0,
      ),
    );
    await app.clickAt("2. cloud-b");
    expect(app.dispatched).toEqual([{ type: "llm_cursor_set", cursor: 1 }]);
    expect(app.calls).toEqual([]);
    app.unmount();
  });

  it("a click on the selected add row replays Enter (opens the picker)", async () => {
    const state = clickableState(
      {
        links: [link("cloud-a", { isActive: true })],
        addableProviderIds: ["cloud-b"],
      },
      1, // cursor on the add row
    );
    const app = mount(state);
    await app.clickAt("+ add link");
    expect(app.dispatched).toEqual([{ type: "fallback_add_picker_opened" }]);
    app.unmount();
  });

  it("a click on the picker's selected row adds that provider via the callback", async () => {
    const state = clickableState({
      links: [link("cloud-a", { isActive: true })],
      addableProviderIds: ["cloud-b", "cloud-c"],
      addPicker: { cursor: 1 },
    });
    const app = mount(state);
    await app.clickAt("cloud-c");
    expect(app.calls).toEqual([["add", "cloud-c"]]);
    expect(app.dispatched).toEqual([{ type: "fallback_add_picker_closed" }]);
    app.unmount();
  });

  it("a click on an unselected picker row moves the picker cursor", async () => {
    const state = clickableState({
      links: [link("cloud-a", { isActive: true })],
      addableProviderIds: ["cloud-b", "cloud-c"],
      addPicker: { cursor: 1 },
    });
    const app = mount(state);
    await app.clickAt("cloud-b");
    expect(app.dispatched).toEqual([
      { type: "fallback_add_picker_cursor_set", cursor: 0 },
    ]);
    expect(app.calls).toEqual([]);
    app.unmount();
  });
});
