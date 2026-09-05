import { Box } from "ink";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import React from "react";

import { setShiftEnterNewline } from "../shift-enter-support.js";
import { fakeSession } from "../test-fixtures.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { HotkeyHint } from "./hotkey-hint.js";

/**
 * The strip must only promise keys the current terminal can deliver.
 * Two things vary at runtime: the newline chip (Shift+Enter exists as a
 * keystroke only under the kitty keyboard protocol — everywhere else it
 * is byte-identical to Enter), and the Ctrl+C/Ctrl+X pair (copy/cut
 * while the composer holds a live selection, abort/quit otherwise).
 */
const ANSI = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const WIDE = 200;

function renderHint(state: TuiState): string {
  const { lastFrame, unmount } = render(
    <Box width={WIDE} flexDirection="column">
      <HotkeyHint state={state} width={WIDE} />
    </Box>,
  );
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

afterEach(() => {
  // The flag is process-global; a test must never leak "kitty" into the
  // suites that render the strip with the default expectation.
  setShiftEnterNewline(false);
});

describe("newline chip vs terminal protocol", () => {
  it("promises alt/option+enter when the terminal has no kitty protocol", () => {
    setShiftEnterNewline(false);
    const out = renderHint(chatState());
    expect(out).toContain("[alt/option+enter] newline");
    expect(out).not.toContain("shift+enter");
  });

  it("promises shift+enter when the kitty protocol was detected", () => {
    setShiftEnterNewline(true);
    const out = renderHint(chatState());
    expect(out).toContain("[shift+enter] newline");
    expect(out).not.toContain("alt/option+enter");
  });
});

describe("copy/cut chips vs composer selection", () => {
  it("advertises copy and cut while a selection is live in the editor", () => {
    const out = renderHint(
      chatState({ composerHasSelection: true, inputValue: "hello" }),
    );
    expect(out).toContain("[ctrl+c] copy");
    expect(out).toContain("[ctrl+x] cut");
    expect(out).not.toContain("quit");
  });

  it("keeps ctrl+c as quit with no selection", () => {
    const out = renderHint(chatState({ inputValue: "hello" }));
    expect(out).toContain("[ctrl+c] quit");
    expect(out).not.toContain("ctrl+x");
  });

  it("keeps ctrl+c as quit when focus moved to the sidebar", () => {
    // The selection flag survives Tab into the sidebar, but the editor
    // no longer receives keys there — Ctrl+C reverts to its global
    // meaning and the strip must not claim otherwise.
    const out = renderHint(
      chatState({
        composerHasSelection: true,
        inputValue: "hello",
        chatFocus: "sidebar",
      }),
    );
    expect(out).toContain("quit");
    expect(out).not.toContain("ctrl+x");
  });

  it("turns ctrl+c into copy during a running turn with a selection", () => {
    const out = renderHint(
      chatState({
        status: "running",
        composerHasSelection: true,
        inputValue: "hello",
      }),
    );
    expect(out).toContain("[ctrl+c] copy");
    expect(out).toContain("[ctrl+x] cut");
    // Esc still aborts and must say so.
    expect(out).toContain("abort");
  });
});
