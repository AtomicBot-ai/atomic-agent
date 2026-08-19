import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "../tui-app.js";
import type { TuiSessionInfo } from "../tui-state.js";
import { makeMouseSource, type MouseSourceEmitter } from "./mouse-source.js";
import type { TuiMouseEvent } from "./mouse-event.js";

const SESSION: TuiSessionInfo = {
  sessionId: "sess-current",
  workingDir: "/tmp/rail",
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

function locate(frame: string, needle: string): { x: number; y: number } {
  for (const [y, line] of strip(frame).split("\n").entries()) {
    const x = line.indexOf(needle);
    if (x !== -1) return { x, y };
  }
  throw new Error(`"${needle}" is not on screen:\n${strip(frame)}`);
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

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function clickUntil(
  mouse: MouseSourceEmitter,
  point: () => { x: number; y: number },
  settled: () => boolean,
  what: string,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { x, y } = point();
    mouse.emit(click(x, y));
    await delay(50);
    if (settled()) return;
  }
  throw new Error(`click never took effect: ${what}`);
}

function mount(callbacks: Partial<TuiAppCallbacks> = {}): {
  frame: () => string;
  mouse: MouseSourceEmitter;
  seedSessions: () => void;
  unmount: () => void;
} {
  const bus = makeTuiEventBus();
  const mouse = makeMouseSource();
  const { lastFrame, unmount } = render(
    <TuiApp
      session={SESSION}
      bus={bus}
      callbacks={{
        onApprovalDecision: () => {},
        onAbort: () => {},
        onQuit: () => {},
        onMessageSubmitted: () => {},
        ...callbacks,
      }}
      mouse={mouse}
    />,
  );
  return {
    frame: () => strip(lastFrame() ?? ""),
    mouse,
    seedSessions: () =>
      bus.emit({
        type: "recent_sessions_updated",
        sessions: [
          { sessionId: "sess-alpha", preview: "alpha thread", updatedAt: 2 },
          { sessionId: "sess-beta", preview: "beta thread", updatedAt: 1 },
        ],
      }),
    unmount,
  };
}

/**
 * The rail is the app's chrome now — brand, menu, location, sessions,
 * tasks — so "can you click it" is the whole question for it.
 */
describe("left rail mouse", () => {
  it("opens the menu when the Menu button is clicked", async () => {
    const app = mount();
    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "Menu"),
      () => app.frame().includes("SESSION"),
      "click on the rail's Menu button",
    );
    expect(app.frame()).toContain("Menu");
    app.unmount();
  });

  it("selects a session row on the first click and opens it on the second", async () => {
    const opened: string[] = [];
    const app = mount({ onSessionSwitchRequested: (id) => opened.push(id) });
    // The bus subscription is installed by an effect; emitting before it
    // runs drops the event on the floor.
    await delay(50);
    app.seedSessions();
    await delay(100);
    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "beta thread"),
      () => opened.includes("sess-beta"),
      "two clicks on a session row",
    );
    expect(opened).toContain("sess-beta");
    app.unmount();
  });
});
