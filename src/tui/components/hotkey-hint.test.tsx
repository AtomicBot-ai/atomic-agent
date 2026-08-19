import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";

import type { ApprovalRequest } from "../../approval/approval-gate.js";
import { fakeSession } from "../test-fixtures.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { HotkeyHint } from "./hotkey-hint.js";

const ANSI = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

// Literal spellings, deliberately NOT derived from process.platform the
// way the component does it — otherwise the assertion would be true by
// construction on every platform.
const MAC_SCROLL_KEY = "fn+↑↓";
const OTHER_SCROLL_KEY = "pgup/pgdn";
const SCROLL_KEY_PATTERN = /fn\+↑↓|pgup\/pgdn/;

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

function fakeApproval(): ApprovalRequest {
  return {
    approvalId: "appr-1",
    sessionId: "sess-1",
    tool: "bash",
    reason: "wants to run a command",
    preview: "rm -rf ./dist",
  };
}

describe("HotkeyHint scroll chip", () => {
  it("advertises the chat-scroll key in the idle chat footer", () => {
    const out = renderHint(chatState());
    expect(out).toMatch(SCROLL_KEY_PATTERN);
    expect(out).toContain("scroll");
    // The scroll chip took ctrl+b's slot to stay within the 6-chip row.
    expect(out).not.toContain("ctrl+b");
  });

  it("advertises the chat-scroll key while a turn is running", () => {
    const out = renderHint(chatState({ status: "running" }));
    expect(out).toMatch(SCROLL_KEY_PATTERN);
    expect(out).toContain("scroll");
  });

  it("keeps modal footers free of the scroll chip", () => {
    const out = renderHint(chatState({ slashPaletteOpen: true }));
    expect(out).not.toContain("scroll");
  });

  it("keeps the approval footer (y/n/esc) free of the scroll chip", () => {
    const out = renderHint(chatState({ pendingApproval: fakeApproval() }));
    expect(out).toContain("approve");
    expect(out).toContain("deny");
    expect(out).toContain("abort run");
    expect(out).not.toContain("scroll");
    expect(out).not.toMatch(SCROLL_KEY_PATTERN);
  });
});

describe("HotkeyHint debug footer", () => {
  it("advertises the way back to Run and drops the duplicate ctrl+b chip", () => {
    const out = renderHint(chatState({ uiMode: "debug" }));
    expect(out).toContain("[esc]");
    expect(out).toContain("back to Run");
    expect(out).toContain("next panel");
    expect(out).toContain("prev panel");
    // Ctrl+B still cycles panels, but its chip repeated the tab chip
    // word-for-word; the freed slot now pays for the esc hint.
    expect(out).not.toContain("ctrl+b");
  });
});

describe("HotkeyHint scroll key spelling per platform", () => {
  const realPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform });
    vi.resetModules();
  });

  // SCROLL_KEY is resolved at module load, so each case re-imports the
  // component after stubbing process.platform.
  async function renderIdleFooterOn(platform: NodeJS.Platform): Promise<string> {
    Object.defineProperty(process, "platform", { value: platform });
    vi.resetModules();
    const fresh = await import("./hotkey-hint.js");
    const { lastFrame, unmount } = render(<fresh.HotkeyHint state={chatState()} />);
    const out = (lastFrame() ?? "").replace(ANSI, "");
    unmount();
    return out;
  }

  it("darwin spells the scroll key as fn+arrows", async () => {
    const out = await renderIdleFooterOn("darwin");
    expect(out).toContain(MAC_SCROLL_KEY);
    expect(out).not.toContain(OTHER_SCROLL_KEY);
  });

  it("linux spells the scroll key as pgup/pgdn", async () => {
    const out = await renderIdleFooterOn("linux");
    expect(out).toContain(OTHER_SCROLL_KEY);
    expect(out).not.toContain(MAC_SCROLL_KEY);
  });
});

describe("HotkeyHint queue affordances", () => {
  it("advertises what Enter does now that the editor stays live mid-run", () => {
    const out = renderHint(chatState({ status: "running" }));
    expect(out).toContain("queue message");
  });

  it("shows how many messages are parked behind the turn", () => {
    const out = renderHint(
      chatState({ status: "running", queuedMessages: ["a", "b"] }),
    );
    expect(out).toContain("2 parked");
  });

  it("hides the parked chip when the queue is empty", () => {
    const out = renderHint(chatState({ status: "running" }));
    expect(out).not.toContain("parked");
  });
});
