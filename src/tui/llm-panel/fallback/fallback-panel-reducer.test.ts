import { describe, expect, it } from "vitest";

import { reduceTuiState } from "../../agent-event-reducer.js";
import { fakeSession } from "../../test-fixtures.js";
import { createInitialTuiState } from "../../tui-state.js";
import type { FallbackLinkRow } from "./fallback-panel-state.js";

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

describe("fallback panel reducer", () => {
  it("mirrors the chain on fallback_refresh", () => {
    const base = createInitialTuiState(fakeSession());
    const next = reduceTuiState(base, {
      type: "fallback_refresh",
      links: [link("cloud-a", { isActive: true }), link("cloud-b")],
      addableProviderIds: ["cloud-c"],
      appendLocal: false,
    });
    expect(next.fallbackPanel.links.map((l) => l.providerId)).toEqual([
      "cloud-a",
      "cloud-b",
    ]);
    expect(next.fallbackPanel.addableProviderIds).toEqual(["cloud-c"]);
    expect(next.fallbackPanel.appendLocal).toBe(false);
  });

  it("re-clamps the pane cursor when a refresh shrinks the row list", () => {
    const base = createInitialTuiState(fakeSession());
    // Cursor parked on row 3 of a 3-links+add layout, then the chain
    // shrinks to one link with nothing addable: only row 0 exists now.
    const parked = {
      ...base,
      llmPanel: { ...base.llmPanel, mode: "fallback" as const, fallbackCursor: 3 },
    };
    const next = reduceTuiState(parked, {
      type: "fallback_refresh",
      links: [link("cloud-a", { isActive: true })],
      addableProviderIds: [],
      appendLocal: false,
    });
    expect(next.llmPanel.fallbackCursor).toBe(0);
  });

  it("keeps the cursor on the add row when only links shrink", () => {
    const base = createInitialTuiState(fakeSession());
    const parked = {
      ...base,
      llmPanel: { ...base.llmPanel, mode: "fallback" as const, fallbackCursor: 3 },
    };
    const next = reduceTuiState(parked, {
      type: "fallback_refresh",
      links: [link("cloud-a", { isActive: true })],
      addableProviderIds: ["cloud-b"],
      appendLocal: false,
    });
    // 1 link + the add row = rows 0..1.
    expect(next.llmPanel.fallbackCursor).toBe(1);
  });

  it("opens, moves, and closes the add-link picker", () => {
    const base = createInitialTuiState(fakeSession());
    const withAddable = reduceTuiState(base, {
      type: "fallback_refresh",
      links: [link("cloud-a", { isActive: true })],
      addableProviderIds: ["cloud-b", "cloud-c"],
      appendLocal: true,
    });
    const opened = reduceTuiState(withAddable, { type: "fallback_add_picker_opened" });
    expect(opened.fallbackPanel.addPicker).toEqual({ cursor: 0 });

    const moved = reduceTuiState(opened, {
      type: "fallback_add_picker_cursor_set",
      cursor: 5,
    });
    // Clamped to the last addable index (1).
    expect(moved.fallbackPanel.addPicker).toEqual({ cursor: 1 });

    const closed = reduceTuiState(moved, { type: "fallback_add_picker_closed" });
    expect(closed.fallbackPanel.addPicker).toBeNull();
  });

  it("does not open the picker when nothing is addable", () => {
    const base = createInitialTuiState(fakeSession());
    const noAddable = reduceTuiState(base, {
      type: "fallback_refresh",
      links: [link("cloud-a", { isActive: true })],
      addableProviderIds: [],
      appendLocal: true,
    });
    const opened = reduceTuiState(noAddable, { type: "fallback_add_picker_opened" });
    expect(opened.fallbackPanel.addPicker).toBeNull();
  });

  it("closes the picker on refresh when the addable list empties", () => {
    const base = createInitialTuiState(fakeSession());
    const opened = reduceTuiState(
      reduceTuiState(base, {
        type: "fallback_refresh",
        links: [link("cloud-a", { isActive: true })],
        addableProviderIds: ["cloud-b"],
        appendLocal: true,
      }),
      { type: "fallback_add_picker_opened" },
    );
    expect(opened.fallbackPanel.addPicker).not.toBeNull();
    const emptied = reduceTuiState(opened, {
      type: "fallback_refresh",
      links: [link("cloud-a", { isActive: true }), link("cloud-b")],
      addableProviderIds: [],
      appendLocal: true,
    });
    expect(emptied.fallbackPanel.addPicker).toBeNull();
  });

  it("records the last provider switch and a status line", () => {
    const base = createInitialTuiState(fakeSession());
    const switched = reduceTuiState(base, {
      type: "fallback_last_switch_set",
      lastSwitch: { direction: "away", from: "cloud-a", to: "cloud-b", reason: "429" },
    });
    expect(switched.fallbackPanel.lastSwitch).toMatchObject({
      direction: "away",
      to: "cloud-b",
    });
    const withStatus = reduceTuiState(switched, {
      type: "fallback_status",
      line: "unknown provider id",
    });
    expect(withStatus.fallbackPanel.statusLine).toBe("unknown provider id");
  });
});

describe("provider_switched agent event", () => {
  it("mirrors a fallover into fallbackPanel.lastSwitch", () => {
    const base = createInitialTuiState(fakeSession());
    const next = reduceTuiState(base, {
      type: "agent_event",
      event: {
        type: "provider_switched",
        direction: "away",
        from: "cloud-a",
        to: "cloud-b",
        reason: "TransportError",
      },
    });
    expect(next.fallbackPanel.lastSwitch).toEqual({
      direction: "away",
      from: "cloud-a",
      to: "cloud-b",
      reason: "TransportError",
    });
  });
});
