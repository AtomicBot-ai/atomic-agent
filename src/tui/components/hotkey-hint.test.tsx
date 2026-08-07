import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import React from "react";

import { fakeSession } from "../test-fixtures.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { HotkeyHint } from "./hotkey-hint.js";

const ANSI = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function renderHint(state: TuiState): string {
  const { lastFrame, unmount } = render(<HotkeyHint state={state} />);
  const out = (lastFrame() ?? "").replace(ANSI, "");
  unmount();
  return out;
}

function chatState(overrides: Partial<TuiState> = {}): TuiState {
  return {
    ...createInitialTuiState(fakeSession()),
    uiMode: "chat" as const,
    ...overrides,
  };
}

const SCROLL_KEY = process.platform === "darwin" ? "fn+↑" : "pgup";

describe("HotkeyHint scroll chip", () => {
  it("advertises the chat-scroll key in the idle chat footer", () => {
    const out = renderHint(chatState());
    expect(out).toContain(SCROLL_KEY);
    expect(out).toContain("scroll");
    // The scroll chip took ctrl+b's slot to stay within the 6-chip row.
    expect(out).not.toContain("ctrl+b");
  });

  it("advertises the chat-scroll key while a turn is running", () => {
    const out = renderHint(chatState({ status: "running" }));
    expect(out).toContain(SCROLL_KEY);
    expect(out).toContain("scroll");
  });

  it("keeps modal footers free of the scroll chip", () => {
    const out = renderHint(chatState({ slashPaletteOpen: true }));
    expect(out).not.toContain("scroll");
  });
});
