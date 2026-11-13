import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "../tui-app.js";
import type { TuiSessionInfo } from "../tui-state.js";

const SESSION: TuiSessionInfo = {
  sessionId: null,
  workingDir: "/tmp/smoke",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

const ESC = String.fromCharCode(27);
/** Ink defers a lone Esc for 20ms; read the frame well past that. */
const FLUSH_MS = 60;

const strip = (value: string): string => value.replace(/\[[0-9;]*m/g, "");

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, FLUSH_MS));

function callbacks(answers: string[], counts: { quit: number }): TuiAppCallbacks {
  return {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {
      counts.quit += 1;
    },
    onMessageSubmitted: () => {},
    onProjectTrustAnswered: (answer) => {
      answers.push(answer);
    },
  };
}

async function openTrustPrompt() {
  const answers: string[] = [];
  const counts = { quit: 0 };
  const bus = makeTuiEventBus();
  const app = render(
    <TuiApp session={SESSION} bus={bus} callbacks={callbacks(answers, counts)} />,
  );
  await settle();
  bus.emit({
    type: "project_trust_asked",
    prompt: { workingDir: "/tmp/smoke", question: "Trust this folder?", questionId: "q1" },
  });
  await settle();
  expect(strip(app.lastFrame() ?? "")).toContain("Trust this folder?");
  return { ...app, answers, counts };
}

/**
 * ATO-1481. The trust question is answered in the app key layer, but the
 * chat editor is an independent `useInput` subscription: unless the prompt
 * is named in `editorFocus`, the same y / n also lands in the draft and
 * Esc falls through to the editor's idle branch, opening the menu.
 */
describe("the project trust question holds the keyboard", () => {
  it("answers y without typing it into the composer", async () => {
    const app = await openTrustPrompt();
    app.stdin.write("y");
    await settle();

    const frame = strip(app.lastFrame() ?? "");
    expect(app.answers).toEqual(["trust"]);
    expect(frame).not.toContain("Trust this folder?");
    expect(frame).not.toContain("❯ y");
    app.unmount();
  });

  it("keeps other keys out of the composer while it is open", async () => {
    const app = await openTrustPrompt();
    app.stdin.write("zqx");
    await settle();

    expect(strip(app.lastFrame() ?? "")).not.toContain("❯ zqx");
    app.unmount();
  });

  it("closes on Esc without also opening the operator menu", async () => {
    const app = await openTrustPrompt();
    app.stdin.write(ESC);
    await settle();

    const frame = strip(app.lastFrame() ?? "");
    expect(frame).not.toContain("Trust this folder?");
    expect(frame).not.toContain("MENU");
    expect(app.answers).toEqual([]);
    expect(app.counts.quit).toBe(0);
    app.unmount();
  });
});
