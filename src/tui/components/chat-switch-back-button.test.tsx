import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";

import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { MouseProvider } from "../mouse/mouse-context.js";
import { MouseTargetRegistry } from "../mouse/mouse-registry.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState, type ChatMessage } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import { ChatSwitchBackButton } from "./chat-switch-back-button.js";
import { FinalisedMessage } from "./chat-finalised-message.js";

function strip(value: string): string {
  return value.replace(/\[[0-9;]*m/g, "");
}

/**
 * Screen position of `needle`. Stripping SGR leaves the visual grid
 * intact, so these are the cells a terminal would report for a click —
 * the same trick `chat-copy-button.test.tsx` uses.
 */
function locate(frame: string, needle: string): { x: number; y: number } {
  for (const [y, line] of frame.split("\n").entries()) {
    const x = line.indexOf(needle);
    if (x !== -1) return { x, y };
  }
  throw new Error(`"${needle}" is not on screen:\n${frame}`);
}

function press(x: number, y: number): TuiMouseEvent {
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
 * The target is registered by an effect that runs after the frame the
 * label first appears in, so the first click can land on a cell nothing
 * owns yet — the same reason `chat-copy-button.test.tsx` re-sends its
 * clicks.
 */
async function clickUntilHandled(
  registry: MouseTargetRegistry,
  frame: () => string,
  needle: string,
  landed: () => boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const at = locate(frame(), needle);
    registry.dispatch(press(at.x, at.y));
    if (landed()) return;
    await delay(25);
  }
  throw new Error(`the click on ${needle} never landed`);
}

function mount(children: ReactNode) {
  const switched: string[] = [];
  const registry = new MouseTargetRegistry();
  const { lastFrame, unmount } = render(
    <MouseProvider
      registry={registry}
      dispatch={() => {}}
      getState={() => createInitialTuiState(fakeSession())}
      callbacks={
        {
          onSessionSwitchRequested: (id: string) => switched.push(id),
        } as TuiAppCallbacks
      }
    >
      {children}
    </MouseProvider>,
  );
  return {
    registry,
    switched,
    frame: () => strip(lastFrame() ?? ""),
    unmount,
  };
}

function systemNotice(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    role: "system",
    text: "the running turn continues in the background on session s-old — switch back to watch or stop it",
    variant: "warn",
    timestamp: 0,
    ...overrides,
  };
}

describe("the switch-back button", () => {
  it("asks for the session the notice names, in one click", async () => {
    const app = mount(<ChatSwitchBackButton sessionId="s-old" />);
    await clickUntilHandled(
      app.registry,
      app.frame,
      "[switch back]",
      () => app.switched.length > 0,
    );
    // The same callback the rail's rows and the picker's Enter use —
    // one switch path, so the re-attach, the replay and the re-raised
    // approval all come along.
    expect(app.switched).toEqual(["s-old"]);
    app.unmount();
  });

  it("rides the footer row of a notice that names a session", () => {
    const app = mount(
      <FinalisedMessage
        message={systemNotice({ switchToSessionId: "s-old" })}
        toolsExpandedById={{}}
        planHandoff={null}
      />,
    );
    expect(app.frame()).toContain("[copy]");
    expect(app.frame()).toContain("[switch back]");
    app.unmount();
  });

  it("is absent from a notice that names none", () => {
    const app = mount(
      <FinalisedMessage
        message={systemNotice({ text: "queue cleared" })}
        toolsExpandedById={{}}
        planHandoff={null}
      />,
    );
    expect(app.frame()).toContain("[copy]");
    expect(app.frame()).not.toContain("[switch back]");
    app.unmount();
  });

  it("still renders the label without a mouse provider", () => {
    const { lastFrame, unmount } = render(
      <ChatSwitchBackButton sessionId="s-old" />,
    );
    expect(lastFrame()).toContain("[switch back]");
    unmount();
  });
});
