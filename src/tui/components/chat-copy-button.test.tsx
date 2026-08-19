import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { ClipboardProvider } from "../clipboard/clipboard-context.js";
import type { ClipboardWriter } from "../clipboard/copy-to-clipboard.js";
import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { MouseProvider } from "../mouse/mouse-context.js";
import { MouseTargetRegistry } from "../mouse/mouse-registry.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState, type TuiSessionInfo } from "../tui-state.js";
import { ChatCopyButton } from "./chat-copy-button.js";

const SESSION: TuiSessionInfo = {
  sessionId: "copy",
  workingDir: "/tmp/copy",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

function strip(value: string): string {
  return value.replace(/\[[0-9;]*m/g, "");
}

/**
 * Screen position of `needle`. Stripping SGR leaves the visual grid
 * intact, so these are the cells a terminal would report for a click —
 * the same trick `mouse-app.test.tsx` uses.
 */
function locate(frame: string, needle: string): { x: number; y: number } {
  for (const [y, line] of frame.split("\n").entries()) {
    const x = line.indexOf(needle);
    if (x !== -1) return { x, y };
  }
  throw new Error(`"${needle}" is not on screen:\n${frame}`);
}

function click(x: number, y: number): TuiMouseEvent {
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

/**
 * Captured before any `vi.useFakeTimers()` call so the polling below
 * keeps running on real time. The fake-timer tests here deliberately
 * fake **only** `setTimeout`/`clearTimeout` — the component's badge
 * window and nothing else. Faking the whole clock would also freeze
 * React's scheduler and Ink's own bookkeeping, and the frame under
 * assertion would simply never repaint.
 */
const realSetTimeout = globalThis.setTimeout;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => realSetTimeout(resolve, ms));

/** Fakes the badge window only. See {@link realSetTimeout}. */
function fakeBadgeTimerOnly(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

/**
 * Ink commits a frame and React flushes the effect that registers the
 * click target on its own schedule, so a freshly rendered button is not
 * clickable for a tick or two. Everything here polls rather than
 * sleeping a fixed interval.
 */
async function waitUntil(
  condition: () => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Harness {
  frame: () => string;
  clickAt: (needle: string) => void;
  clickCell: (x: number, y: number) => void;
  unmount: () => void;
}

function noopCallbacks(): TuiAppCallbacks {
  return {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {},
    onMessageSubmitted: () => {},
  };
}

function mount(
  writer: ClipboardWriter,
  children: ReactNode,
  { withMouse = true }: { withMouse?: boolean } = {},
): Harness {
  const registry = new MouseTargetRegistry();
  const state = createInitialTuiState(SESSION);
  const tree: ReactElement = withMouse ? (
    <MouseProvider
      registry={registry}
      dispatch={() => {}}
      callbacks={noopCallbacks()}
      getState={() => state}
    >
      {children}
    </MouseProvider>
  ) : (
    <>{children}</>
  );
  const { lastFrame, unmount } = render(
    <ClipboardProvider writer={writer}>{tree}</ClipboardProvider>,
  );
  const frame = (): string => strip(lastFrame() ?? "");
  return {
    frame,
    clickAt: (needle) => {
      const at = locate(frame(), needle);
      registry.dispatch(click(at.x, at.y));
    },
    clickCell: (x, y) => registry.dispatch(click(x, y)),
    unmount,
  };
}

/**
 * Clicks `[copy]` until the click actually lands. The target is
 * registered by an effect that runs after the frame the label first
 * appears in, so the first click can fall on a cell nothing owns yet —
 * the same reason `mouse-app.test.tsx` re-sends its clicks.
 */
async function clickCopy(app: Harness, copied: readonly string[]): Promise<void> {
  await waitUntil(() => app.frame().includes("[copy]"), "the idle label");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (copied.length > 0) return;
    app.clickAt("[copy]");
    await delay(25);
  }
  throw new Error("click never took effect on the copy button");
}

function recordingWriter(result = true): {
  writer: ClipboardWriter;
  copied: string[];
} {
  const copied: string[] = [];
  return {
    copied,
    writer: {
      copy: async (text: string) => {
        copied.push(text);
        return result;
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ChatCopyButton", () => {
  it("renders the quiet idle label", () => {
    const app = mount(recordingWriter().writer, <ChatCopyButton text="hi" />);
    expect(app.frame()).toContain("[copy]");
    app.unmount();
  });

  it("still renders without a mouse provider", () => {
    // `useMouseCommands()` is null under `--no-mouse` and in every
    // component test; the button must degrade to a label, not vanish.
    const app = mount(recordingWriter().writer, <ChatCopyButton text="hi" />, {
      withMouse: false,
    });
    expect(app.frame()).toContain("[copy]");
    app.unmount();
  });

  it("copies the message text and flips the label when clicked", async () => {
    const { writer, copied } = recordingWriter();
    const app = mount(writer, <ChatCopyButton text="the exact reply" />);
    await clickCopy(app, copied);
    expect(copied).toEqual(["the exact reply"]);
    await waitUntil(
      () => app.frame().includes("[copied!]"),
      "the copied badge",
    );
    app.unmount();
  });

  it("reports a refused copy instead of claiming success", async () => {
    const { writer, copied } = recordingWriter(false);
    const app = mount(writer, <ChatCopyButton text="nope" />);
    await clickCopy(app, copied);
    await waitUntil(
      () => app.frame().includes("[copy failed]"),
      "the failure badge",
    );
    app.unmount();
  });

  it("copies the message its own button belongs to, not a neighbour's", async () => {
    const { writer, copied } = recordingWriter();
    const app = mount(
      writer,
      <>
        <ChatCopyButton text="first message" />
        <ChatCopyButton text="second message" />
      </>,
    );
    await waitUntil(() => app.frame().split("[copy]").length === 3, "both buttons");
    // The second button is the second `[copy]` on screen — one row down.
    const first = locate(app.frame(), "[copy]");
    for (let attempt = 0; attempt < 40 && copied.length === 0; attempt += 1) {
      app.clickCell(first.x, first.y + 1);
      await delay(25);
    }
    expect(copied).toEqual(["second message"]);
    app.unmount();
  });

  it("does not leave a timer behind when unmounted mid-badge", async () => {
    fakeBadgeTimerOnly();
    const { writer, copied } = recordingWriter();
    const app = mount(writer, <ChatCopyButton text="hi" revertAfterMs={5_000} />);
    await clickCopy(app, copied);
    await waitUntil(() => app.frame().includes("[copied!]"), "the copied badge");
    // Only the badge window is faked, so this count is the component's
    // pending revert and nothing else.
    expect(vi.getTimerCount()).toBe(1);
    app.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("ChatCopyButton label timer", () => {
  it("reverts to the idle label once the badge window elapses", async () => {
    fakeBadgeTimerOnly();
    const { writer, copied } = recordingWriter();
    const app = mount(
      writer,
      <ChatCopyButton text="hi" revertAfterMs={5_000} />,
    );
    await clickCopy(app, copied);
    await waitUntil(() => app.frame().includes("[copied!]"), "the copied badge");
    vi.advanceTimersByTime(4_999);
    expect(app.frame()).toContain("[copied!]");
    vi.advanceTimersByTime(1);
    await waitUntil(
      () => app.frame().includes("[copy]") && !app.frame().includes("[copied!]"),
      "the label reverting on its own",
    );
    app.unmount();
  });

  it("a second click restarts the window instead of letting the first timer clear it", async () => {
    fakeBadgeTimerOnly();
    const { writer, copied } = recordingWriter();
    const app = mount(
      writer,
      <ChatCopyButton text="hi" revertAfterMs={5_000} />,
    );
    await clickCopy(app, copied);
    await waitUntil(() => app.frame().includes("[copied!]"), "the copied badge");
    vi.advanceTimersByTime(4_000);
    const seen = copied.length;
    app.clickAt("[copied!]");
    await waitUntil(() => copied.length > seen, "the second copy");
    // `copied` grows inside `copy()`; the badge timer is only restarted
    // in the `.then` after it. Give that microtask a real tick.
    await delay(25);
    // The first click's timeout is due 1s from here. If it had not been
    // cleared, the badge would blink off a second after the re-click.
    vi.advanceTimersByTime(2_000);
    expect(vi.getTimerCount()).toBe(1);
    expect(app.frame()).toContain("[copied!]");
    app.unmount();
  });
});
