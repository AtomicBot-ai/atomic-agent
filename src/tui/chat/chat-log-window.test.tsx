import { Box, measureElement, type DOMElement } from "ink";
import { render } from "ink-testing-library";
import { createElement, useEffect, useRef, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { selectComposerBackend } from "../composer-switch/composer-backend-selectors.js";
import { reduceUiAction } from "../reduce-ui-actions.js";
import { turnFoldsOf } from "../render/turn-collapse.js";
import { fakeSession } from "../test-fixtures.js";
import type { TuiAction } from "../tui-action.js";
import {
  createInitialTuiState,
  type ChatMessage,
  type TuiState,
} from "../tui-state.js";
import { ChatLog } from "./chat-log.js";
import { WindowedMessages } from "./windowed-messages.js";

// Records which finalised messages were rendered at all, so the tests
// can tell a message that was windowed out from one that was drawn and
// merely clipped. The real component still renders.
const drawn = vi.hoisted(() => new Set<string>());
vi.mock("./chat-finalised-message.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./chat-finalised-message.js")>();
  return {
    ...actual,
    FinalisedMessage: (
      props: Parameters<typeof actual.FinalisedMessage>[0],
    ) => {
      drawn.add(props.message.id);
      return createElement(actual.FinalisedMessage, props);
    },
  };
});

const SESSION = fakeSession({
  sessionId: "abc",
  workingDir: "/tmp",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
});

function strip(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

/** `msg #N.`: the period keeps `#1.` from matching inside `#10.`. */
function history(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, idx) => ({
    id: `m${idx}`,
    role: "user" as const,
    text: `msg #${idx}.`,
    timestamp: idx,
  }));
}

/** A user prompt and an assistant reply with one read card, `turns` times. */
function historyWithTools(turns: number): ChatMessage[] {
  return Array.from({ length: turns }, (_, idx): ChatMessage[] => [
    { id: `u${idx}`, role: "user", text: `ask #${idx}.`, timestamp: idx * 2 },
    {
      id: `a${idx}`,
      role: "assistant",
      text: `read #${idx}.`,
      toolSteps: 1,
      toolCards: [
        {
          id: `tc${idx}`,
          stepIndex: 0,
          tool: "os.fs.read",
          args: { path: `/tmp/notes-${idx}.txt`, offset: 0, limit: 40 },
          status: "ok",
          summary: `read /tmp/notes-${idx}.txt`,
          truncated: false,
          startedAt: idx * 2,
          finishedAt: idx * 2 + 1,
        },
      ],
      timestamp: idx * 2 + 1,
    },
  ]).flat();
}

function apply(state: TuiState, actions: readonly TuiAction[]): TuiState {
  return actions.reduce((acc, action) => reduceUiAction(acc, action) ?? acc, state);
}

/** "Expand all": every turn opened and every tool card expanded. */
const EXPAND_ALL: readonly TuiAction[] = [
  { type: "turn_expand_set", scope: "all", expanded: true },
  { type: "tool_expand_all_set", expanded: true },
];

/**
 * Rows of every finalised message drawn at once, the way ChatLog drew
 * them before windowing: the reference a windowed log must add up to.
 */
async function unwindowedRows(state: TuiState): Promise<number> {
  let rows = -1;
  function Column(): ReactElement {
    const ref = useRef<DOMElement>(null);
    useEffect(() => {
      if (ref.current) rows = measureElement(ref.current).height;
    });
    return (
      <Box ref={ref} flexDirection="column" flexShrink={0}>
        <WindowedMessages
          messages={state.messages}
          start={0}
          end={state.messages.length}
          refFor={() => () => {}}
          state={state}
          fusion={selectComposerBackend(state) === "fusion"}
          folds={turnFoldsOf(state.messages, {
            always: state.showSteps,
            running: state.status === "running",
          })}
        />
      </Box>
    );
  }
  const app = render(<Column />);
  await settle();
  app.unmount();
  return rows;
}

/** The `scrolled up N lines` hint: at the top it is the scroll clamp. */
function hintOffset(frame: string | undefined): number | null {
  const match = /scrolled up (\d+) line/.exec(strip(frame ?? ""));
  return match ? Number(match[1]) : null;
}

function stateWith(messages: ChatMessage[], scroll = 0): TuiState {
  return {
    ...createInitialTuiState(SESSION),
    messages,
    chatScrollOffset: scroll,
  };
}

/** Lets the post-commit measurements land and the re-render they ask for. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("ChatLog windowing (ATO-650)", () => {
  it("draws only the newest messages of a long history when pinned to the bottom", async () => {
    drawn.clear();
    const app = render(<ChatLog state={stateWith(history(300))} />);
    await settle();
    const frame = strip(app.lastFrame() ?? "");
    expect(frame).toContain("msg #299.");
    expect(frame).not.toContain("msg #0.");
    expect(drawn.has("m299")).toBe(true);
    expect(drawn.has("m0")).toBe(false);
    // A viewport plus a screen of overscan either side, not 300.
    expect(drawn.size).toBeLessThan(60);
    app.unmount();
  });

  it("still scrolls all the way up to the first message", async () => {
    drawn.clear();
    const app = render(
      <ChatLog state={stateWith(history(300), Number.MAX_SAFE_INTEGER)} />,
    );
    await settle();
    const frame = strip(app.lastFrame() ?? "");
    expect(frame).toContain("msg #0.");
    expect(frame).not.toContain("msg #299.");
    expect(frame).toContain("scrolled up");
    expect(drawn.has("m299")).toBe(false);
    app.unmount();
  });

  it("shows the same rows at a mid-history offset as an unwindowed log would", async () => {
    // The same 200 newest messages, once alone and once under 150 older
    // ones. Scrolling is counted from the bottom, so the same offset
    // must paint the same screen, whatever the spacer above stands in
    // for and however much of it was only estimated.
    const recent = history(350).slice(150);
    const tall = history(350);
    const offset = 40;
    const short = render(<ChatLog state={stateWith(recent, offset)} />);
    await settle();
    const shortLines = strip(short.lastFrame() ?? "").split("\n");
    short.unmount();
    const long = render(<ChatLog state={stateWith(tall, offset)} />);
    await settle();
    const longLines = strip(long.lastFrame() ?? "").split("\n");
    long.unmount();
    const row = shortLines.findIndex((line) => line.includes("msg #"));
    expect(row).toBeGreaterThanOrEqual(0);
    expect(longLines).toEqual(shortLines);
  });

  it("draws a message again when the window comes back to it", async () => {
    drawn.clear();
    const messages = history(300);
    const app = render(
      <ChatLog state={stateWith(messages, Number.MAX_SAFE_INTEGER)} />,
    );
    await settle();
    app.rerender(<ChatLog state={stateWith(messages, 0)} />);
    await settle();
    const frame = strip(app.lastFrame() ?? "");
    expect(frame).toContain("msg #299.");
    expect(frame).not.toContain("scrolled up");
    app.unmount();
  });

  it("adds up to the unwindowed height after expand all, measured rows included", async () => {
    // Scroll through the whole history so every message gets measured
    // collapsed, go back to the bottom, expand everything, then read the
    // scroll clamp. A cache keyed by width alone kept the collapsed
    // rows of every off-screen message, so the clamp (and the window
    // slice) stayed at the collapsed height.
    const collapsed = { ...createInitialTuiState(SESSION), messages: historyWithTools(150) };
    expect(collapsed.messages).toHaveLength(300);
    const expanded = apply(collapsed, EXPAND_ALL);
    const at = (state: TuiState, scroll: number): TuiState => ({
      ...state,
      chatScrollOffset: scroll,
    });
    const app = render(<ChatLog state={at(collapsed, 0)} />);
    await settle();
    // 16 rows a step: the drawn band is the viewport plus at least 8
    // rows of overscan each side, so no message is stepped over.
    for (let scroll = 16; scroll < 100_000; scroll += 16) {
      app.rerender(<ChatLog state={at(collapsed, scroll)} />);
      await settle();
      const shown = hintOffset(app.lastFrame());
      if (shown !== null && shown < scroll) break;
    }
    app.rerender(<ChatLog state={at(collapsed, Number.MAX_SAFE_INTEGER)} />);
    await settle();
    const topBefore = hintOffset(app.lastFrame());
    app.rerender(<ChatLog state={at(collapsed, 0)} />);
    await settle();

    app.rerender(<ChatLog state={at(expanded, 0)} />);
    await settle();
    await settle();
    app.rerender(<ChatLog state={at(expanded, Number.MAX_SAFE_INTEGER)} />);
    await settle();
    const topAfter = hintOffset(app.lastFrame());
    app.unmount();

    const collapsedRows = await unwindowedRows(collapsed);
    const expandedRows = await unwindowedRows(expanded);
    expect(expandedRows).toBeGreaterThan(collapsedRows);
    expect(topBefore).not.toBeNull();
    expect(topAfter).not.toBeNull();
    // The clamp is the measured inner height minus the viewport, so the
    // viewport falls out of the collapsed pass, where every message was
    // measured, and the expanded pass must match the unwindowed height.
    const viewport = collapsedRows - topBefore!;
    expect(viewport).toBeGreaterThan(0);
    expect(topAfter! + viewport).toBe(expandedRows);
  }, 60_000);
});
