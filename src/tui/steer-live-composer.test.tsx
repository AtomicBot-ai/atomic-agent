import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "./tui-app.js";
import type { TuiSessionInfo } from "./tui-state.js";

/**
 * End-to-end through the real key layers, for the one thing a steer
 * used to leave unsaid: that it was sent at all. The editor stays live
 * for the whole turn, Enter folds the message into it — and until the
 * loop reaches its next step boundary, which a slow tool call can hold
 * off for minutes, the only sign anything happened was the editor
 * going blank. The bubble now lands immediately, at the end of the
 * chat — where a message you send lands in any chat — with the
 * spinner still below it and the prompt below that.
 */
const SESSION: TuiSessionInfo = {
  sessionId: "s1",
  workingDir: "/tmp/steer",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 1,
  maxSteps: 10,
  skillCount: 0,
};

const ESC = String.fromCharCode(27);
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 60));
const strip = (value: string): string =>
  value.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");

function harness() {
  const steered: string[] = [];
  const submitted: string[] = [];
  const callbacks: TuiAppCallbacks = {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {},
    onMessageSubmitted: (text) => submitted.push(text),
    onMessageSteered: (text) => steered.push(text),
  };
  const bus = makeTuiEventBus();
  const app = render(
    <TuiApp session={SESSION} bus={bus} callbacks={callbacks} />,
  );
  return { steered, submitted, bus, ...app };
}

/** Row of the first line containing `needle`, or -1. */
function rowOf(frame: string, needle: string): number {
  return frame.split("\n").findIndex((line) => line.includes(needle));
}

describe("a steer sent into a running turn", () => {
  it("draws the message at the end of the chat, over the spinner", async () => {
    const { steered, bus, stdin, lastFrame, unmount } = harness();
    await settle();
    bus.emitAgentEvent({ type: "user_message", text: "deploy the api" });
    bus.emitAgentEvent({ type: "turn_started", turnIndex: 0 });
    bus.emitAgentEvent({ type: "step_started", stepIndex: 0 });
    await settle();

    stdin.write("wait, use staging");
    await settle();
    stdin.write("\r");
    await settle();

    // It went to the runtime, and the editor is clear for the next one.
    expect(steered).toEqual(["wait, use staging"]);

    const frame = strip(lastFrame() ?? "");
    const bubble = rowOf(frame, "wait, use staging");
    expect(bubble).toBeGreaterThan(-1);
    // Below the turn it is correcting...
    expect(bubble).toBeGreaterThan(rowOf(frame, "deploy the api"));
    // ...and above the spinner, which stays pinned to the bottom of the
    // chat as the live thing: the turn is still working, and it is
    // working on this now.
    const spinner = rowOf(frame, "thinking");
    expect(spinner).toBeGreaterThan(-1);
    expect(bubble).toBeLessThan(spinner);
    // ...and above the prompt it was typed into: the operator's eye
    // does not have to leave the composer to see that it was taken.
    const prompt = rowOf(frame, "send \u2192");
    expect(prompt).toBeGreaterThan(-1);
    expect(bubble).toBeLessThan(prompt);
    // Once, not twice: the editor blanked, so the bubble is the only
    // copy of the message on screen.
    expect(frame.match(/wait, use staging/g)).toHaveLength(1);
    // Labelled with when it will be read, not as though it already was.
    expect(frame).toContain("the agent reads it at the next step");
    unmount();
  });

  it("promotes the bubble into the transcript when the step reads it", async () => {
    const { bus, stdin, lastFrame, unmount } = harness();
    await settle();
    bus.emitAgentEvent({ type: "turn_started", turnIndex: 0 });
    bus.emitAgentEvent({ type: "step_started", stepIndex: 0 });
    await settle();

    stdin.write("wait, use staging");
    await settle();
    stdin.write("\r");
    await settle();

    bus.emitAgentEvent({
      type: "steer_applied",
      text: "wait, use staging",
      stepIndex: 1,
    });
    await settle();

    const frame = strip(lastFrame() ?? "");
    // One message, one bubble: the pending copy gave way to the
    // transcript one, which says it is part of the turn now.
    expect(frame.match(/wait, use staging/g)).toHaveLength(1);
    expect(frame).toContain("steered into the running turn");
    expect(frame).not.toContain("the agent reads it at the next step");
    unmount();
  });
});
