import { Box } from "ink";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";

import type { ApprovalRequest } from "../../approval/approval-gate.js";
import { APPROVAL_CHORDS } from "../app-key-bindings.js";
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

/**
 * Wide enough that no chip is shed — these cases assert *which* chips a
 * state offers, not how the row degrades. Narrow behaviour has its own
 * describe block below.
 */
const WIDE = 200;

/**
 * The strip is rendered inside a column-direction Box exactly as
 * `TuiApp` renders it, so Ink resolves the same width and the frame we
 * assert on is the frame the operator sees at `columns`.
 */
function renderHint(state: TuiState, columns: number = WIDE): string {
  const { lastFrame, unmount } = render(
    <Box width={columns} flexDirection="column">
      <HotkeyHint state={state} width={columns} />
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

/** Chips are `[key] label`; counting the brackets counts the chips. */
function chipCount(frame: string): number {
  return (frame.match(/\[/g) ?? []).length;
}

function widest(frame: string): number {
  return Math.max(0, ...frame.split("\n").map((line) => line.length));
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

  it("keeps the approval footer free of the scroll chip", () => {
    const out = renderHint(chatState({ pendingApproval: fakeApproval() }));
    expect(out).toContain("approve");
    expect(out).toContain("deny");
    expect(out).toContain("abort run");
    expect(out).not.toContain("scroll");
    expect(out).not.toMatch(SCROLL_KEY_PATTERN);
  });

  it("advertises the chords the approval prompt actually answers to", () => {
    // This strip and the modal above it are the two places that tell an
    // operator how to answer. They disagreed: the modal said `ctrl+y` /
    // `ctrl+d` (what `approvalHotkey` accepts, because the composer
    // stays live and a bare letter is text) while the strip said `y` /
    // `n`. Pressing what the strip advertised typed into the draft.
    const out = renderHint(chatState({ pendingApproval: fakeApproval() }));
    expect(out).toContain(`ctrl+${APPROVAL_CHORDS.approve}`);
    expect(out).toContain(`ctrl+${APPROVAL_CHORDS.deny}`);
    // Not the bare letters — `[y]` is the chip shape, so this catches a
    // regression to the old keys without tripping on the word "approve".
    expect(out).not.toContain("[y]");
    expect(out).not.toContain("[n]");
  });
});

// Renders are the expensive part of this file (~2s each under Ink), so
// each case below is one render and asserts everything it can from it.
describe("HotkeyHint draft chips", () => {
  it("adds an esc / clear-draft chip once a draft exists", () => {
    // The ctrl+p chip is not inert with a draft (the menu opens either
    // way), so nothing is swapped out: the affordance rides as an extra
    // chip on a wide surface and the shed ranks pay for it when the row
    // narrows. Eight with the ctrl+r route chip.
    const out = renderHint(chatState({ inputValue: "half a thought" }));
    expect(out).toContain("[esc]");
    expect(out).toContain("clear draft");
    expect(out).toContain("[ctrl+p]");
    expect(chipCount(out)).toBe(8);
  });

  it("keeps the empty idle footer free of the clear-draft chip", () => {
    const out = renderHint(chatState());
    expect(out).not.toContain("clear draft");
    expect(out).toContain("[ctrl+p]");
    expect(out).toContain("menu");
    // On an empty buffer Esc opens the menu, so the strip says so — the
    // same slot that carries `clear draft` once there is a draft.
    expect(out).toContain("[esc]");
    expect(chipCount(out)).toBe(8);
    // The keyboard route to the composer's three controls is written
    // down here, not only inside the popup it opens.
    expect(out).toContain("[ctrl+r]");
    expect(out).toContain("route");
  });

  it("tells the operator the draft survives an abort mid-turn", () => {
    const out = renderHint(
      chatState({ status: "running", inputValue: "half a thought" }),
    );
    expect(out).toContain("[esc]");
    expect(out).toContain("abort, draft kept");
    // Clearing is not on offer while a turn is in flight — abort wins.
    expect(out).not.toContain("clear draft");
  });

  it("leaves the running label plain when there is no draft to keep", () => {
    const out = renderHint(chatState({ status: "running" }));
    expect(out).toContain("[esc]");
    expect(out).toContain("abort");
    expect(out).not.toContain("draft");
  });
});

/**
 * Ink wraps an over-wide row instead of clipping it, which both costs a
 * row `debug-pane` budgeted away (`APP_CHROME_ROWS` counts the strip as
 * 1) and smears chips across two lines with their separators stranded.
 * The strip must therefore stay exactly one row, shedding whole chips
 * rather than letting Yoga chop them.
 */
describe("HotkeyHint narrow-width degradation", () => {
  it("sheds the scroll hint before send / clear-draft / quit at 80 columns", () => {
    const out = renderHint(chatState({ inputValue: "half a thought" }), 80);
    expect(out.split("\n")).toHaveLength(1);
    expect(widest(out)).toBeLessThanOrEqual(80);
    expect(out).not.toMatch(SCROLL_KEY_PATTERN);
    expect(out).toContain("send");
    expect(out).toContain("clear draft");
    expect(out).toContain("quit");
  });

  it("keeps the running strip and its abort label on one row at 80 columns", () => {
    const out = renderHint(
      chatState({ status: "running", inputValue: "half a thought" }),
      80,
    );
    expect(out.split("\n")).toHaveLength(1);
    expect(widest(out)).toBeLessThanOrEqual(80);
    expect(out).toContain("abort, draft kept");
  });

  it("keeps the debug footer on one row at 80 columns", () => {
    const out = renderHint(chatState({ uiMode: "debug" }), 80);
    expect(out.split("\n")).toHaveLength(1);
    expect(widest(out)).toBeLessThanOrEqual(80);
    expect(out).toContain("back to Run");
  });

  it("clips instead of wrapping once only essential chips are left", () => {
    // 40 columns cannot hold even the essentials; `truncate-end` must
    // take the overflow rather than Ink adding a second row.
    const out = renderHint(chatState({ inputValue: "half a thought" }), 40);
    expect(out.split("\n")).toHaveLength(1);
    expect(widest(out)).toBeLessThanOrEqual(40);
    expect(out).toContain("[enter]");
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

describe("HotkeyHint pending ctrl+g leader", () => {
  it("says the leader is waiting instead of showing the idle chips", () => {
    const { lastFrame, unmount } = render(
      <HotkeyHint state={chatState()} menuLeaderArmed />,
    );
    const out = (lastFrame() ?? "").replace(ANSI, "");
    unmount();
    expect(out).toContain("ctrl+g");
    expect(out).toContain("waiting for a chord");
    expect(out).toContain("[esc]");
    expect(out).toContain("cancel");
    // The armed leader unfocuses the editor and eats the next key, so the
    // strip must not keep advertising chips that no longer apply.
    expect(out).not.toContain("send");
  });

  it("keeps the approval footer, which outranks the leader on keys", () => {
    const { lastFrame, unmount } = render(
      <HotkeyHint state={chatState({ pendingApproval: fakeApproval() })} menuLeaderArmed />,
    );
    const out = (lastFrame() ?? "").replace(ANSI, "");
    unmount();
    expect(out).toContain("approve");
    expect(out).not.toContain("waiting for a chord");
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
    const { lastFrame, unmount } = render(
      <Box width={WIDE} flexDirection="column">
        <fresh.HotkeyHint state={chatState()} width={WIDE} />
      </Box>,
    );
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
    const steering = renderHint(chatState({ status: "running" }));
    expect(steering).toContain("⏎");
    expect(steering).toContain("steer");
    const queueing = renderHint(
      chatState({ status: "running", whileBusyMode: "queue" }),
    );
    expect(queueing).toContain("queue");
  });

  it("offers ctrl+t as the way to flip to the other mode", () => {
    const steering = renderHint(chatState({ status: "running" }));
    expect(steering).toMatch(/ctrl\+t\]\s*queue/);
    const queueing = renderHint(
      chatState({ status: "running", whileBusyMode: "queue" }),
    );
    expect(queueing).toMatch(/ctrl\+t\]\s*steer/);
  });

  it("shows how many messages are parked behind the turn", () => {
    const out = renderHint(
      chatState({ status: "running", queuedMessages: ["a", "b"] }),
    );
    expect(out).toContain("parked");
    expect(out).toContain("2");
  });

  it("hides the parked chip when the queue is empty", () => {
    const out = renderHint(chatState({ status: "running" }));
    expect(out).not.toContain("queued");
  });

  it("stays on one row at 80 columns while running with a full queue", () => {
    // The strip is a single-row affordance; wrapping pushes the prompt
    // down and reads as a layout bug.
    const out = renderHint(
      chatState({ status: "running", queuedMessages: ["a", "b", "c"] }),
    );
    expect(out.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(1);
  });

  it("gives an armed ctrl+c the whole row", () => {
    const { lastFrame, unmount } = render(
      <HotkeyHint state={chatState({ status: "running" })} ctrlCArmed />,
    );
    const out = (lastFrame() ?? "").replace(ANSI, "");
    unmount();
    expect(out).toContain("press again to quit");
    expect(out).not.toContain("ctrl+t");
  });
});
