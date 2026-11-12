import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { fakeSession } from "../test-fixtures.js";
import {
  createInitialTuiState,
  type ChatMessage,
  type TuiState,
} from "../tui-state.js";
import { ChatLog } from "./chat-log.js";

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
});
