import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { reduceTuiState } from "../agent-event-reducer.js";
import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { MouseProvider } from "../mouse/mouse-context.js";
import { MouseTargetRegistry } from "../mouse/mouse-registry.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState, type TuiSessionInfo, type TuiState } from "../tui-state.js";
import { ChatTryAgainButton } from "./chat-try-again-button.js";

const SESSION: TuiSessionInfo = {
  sessionId: "again",
  workingDir: "/tmp/again",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

function strip(value: string): string {
  return value.replace(/\[[0-9;]*m/g, "");
}

/** Screen cell of `needle` — the position a terminal reports for a click. */
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

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ink commits frames on a throttle and the effect that registers a click
 * target runs after the frame the label first appears in, so nothing
 * here sleeps a fixed interval — it polls. Same reason
 * `chat-copy-button.test.tsx` and `mouse-app.test.tsx` re-send clicks.
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
  /** Clicks the label until the registry actually owns those cells. */
  clickUntil: (needle: string, landed: () => boolean) => Promise<void>;
  clickOnce: (needle: string) => void;
  state: () => TuiState;
  actions: TuiAction[];
  submitted: string[];
  steered: string[];
  unmount: () => void;
}

function mount(
  children: ReactNode,
  { withMouse = true, initial }: { withMouse?: boolean; initial?: TuiState } = {},
): Harness {
  const registry = new MouseTargetRegistry();
  // A real reducer behind the provider: the point of these tests is what
  // the submit path does to `TuiState`, and a stub dispatch would assert
  // only that the component called something.
  let state = initial ?? createInitialTuiState(SESSION);
  const actions: TuiAction[] = [];
  const dispatch = (action: TuiAction): void => {
    actions.push(action);
    state = reduceTuiState(state, action);
  };
  const submitted: string[] = [];
  const steered: string[] = [];
  const callbacks: TuiAppCallbacks = {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {},
    onMessageSubmitted: (text) => submitted.push(text),
    onMessageSteered: (text) => steered.push(text),
  };
  const tree: ReactElement = withMouse ? (
    <MouseProvider
      registry={registry}
      dispatch={dispatch}
      callbacks={callbacks}
      getState={() => state}
    >
      {children}
    </MouseProvider>
  ) : (
    <>{children}</>
  );
  const { lastFrame, unmount } = render(tree);
  const frame = (): string => strip(lastFrame() ?? "");
  const clickOnce = (needle: string): void => {
    const at = locate(frame(), needle);
    registry.dispatch(click(at.x, at.y));
  };
  return {
    frame,
    clickOnce,
    clickUntil: async (needle, landed) => {
      await waitUntil(() => frame().includes(needle), `the ${needle} label`);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (landed()) return;
        clickOnce(needle);
        await delay(25);
      }
      throw new Error(`click never took effect on ${needle}`);
    },
    state: () => state,
    actions,
    submitted,
    steered,
    unmount,
  };
}

describe("ChatTryAgainButton", () => {
  it("renders the quiet idle label", () => {
    const app = mount(<ChatTryAgainButton text="hi" />);
    expect(app.frame()).toContain("[try again]");
    app.unmount();
  });

  it("still renders without a mouse provider", () => {
    const app = mount(<ChatTryAgainButton text="hi" />, { withMouse: false });
    expect(app.frame()).toContain("[try again]");
    app.unmount();
  });

  it("re-sends the message through the normal submit path", async () => {
    const app = mount(<ChatTryAgainButton text="list the files" />);
    await app.clickUntil("[try again]", () => app.submitted.length > 0);
    expect(app.submitted).toEqual(["list the files"]);
    // `message_submitted` is what Enter dispatches — the re-run starts a
    // real turn rather than poking the orchestrator behind the reducer.
    expect(app.actions.map((a) => a.type)).toContain("message_submitted");
    await waitUntil(() => app.frame().includes("[sent]"), "the sent badge");
    app.unmount();
  });

  it("keeps an unsent draft in the composer", async () => {
    const initial: TuiState = {
      ...createInitialTuiState(SESSION),
      inputValue: "half-written thought",
    };
    const app = mount(<ChatTryAgainButton text="run that again" />, { initial });
    await app.clickUntil("[try again]", () => app.submitted.length > 0);
    expect(app.submitted).toEqual(["run that again"]);
    // Submitting blanks `inputValue` (`startNewRun`); the draft is put
    // back afterwards, so the re-run costs a turn and not the operator's
    // half-typed message.
    expect(app.state().inputValue).toBe("half-written thought");
    app.unmount();
  });

  it("steers into the running turn when that is what Enter would do", async () => {
    const initial: TuiState = {
      ...createInitialTuiState(SESSION),
      status: "running",
      whileBusyMode: "steer",
    };
    const app = mount(<ChatTryAgainButton text="try that again" />, { initial });
    await app.clickUntil("[try again]", () => app.steered.length > 0);
    expect(app.steered).toEqual(["try that again"]);
    // Not a second turn: the routing is `handleEditorSubmit`'s, not ours.
    expect(app.submitted).toEqual([]);
    expect(app.state().status).toBe("running");
    app.unmount();
  });

  it("queues into the running turn when that is what Enter would do", async () => {
    const initial: TuiState = {
      ...createInitialTuiState(SESSION),
      status: "running",
      whileBusyMode: "queue",
    };
    const app = mount(<ChatTryAgainButton text="and again" />, { initial });
    await app.clickUntil("[try again]", () => app.submitted.length > 0);
    expect(app.steered).toEqual([]);
    expect(app.state().queuedMessages).toEqual(["and again"]);
    app.unmount();
  });

  it("ignores the second press of a double-click, then re-arms", async () => {
    const app = mount(
      <ChatTryAgainButton text="expensive turn" revertAfterMs={300} />,
    );
    // The first send starts a turn, so the second one steers into it —
    // count both landings, since which one fires is the submit path's
    // decision and this test is about how many times it was asked.
    const sends = (): number => app.submitted.length + app.steered.length;
    await app.clickUntil("[try again]", () => sends() > 0);
    await waitUntil(() => app.frame().includes("[sent]"), "the sent badge");
    // A terminal reports a double-click as two presses; a turn is not
    // free, so the badge window swallows the second one.
    app.clickOnce("[sent]");
    await delay(50);
    expect(sends()).toBe(1);
    // The guard is a window, not a latch.
    await waitUntil(
      () => app.frame().includes("[try again]"),
      "the label re-arming",
    );
    await app.clickUntil("[try again]", () => sends() > 1);
    expect(app.submitted).toEqual(["expensive turn"]);
    expect(app.steered).toEqual(["expensive turn"]);
    app.unmount();
  });
});
