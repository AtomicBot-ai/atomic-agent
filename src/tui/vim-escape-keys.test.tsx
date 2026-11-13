import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "./tui-app.js";
import type { TuiSessionInfo } from "./tui-state.js";
import type { ApprovalRequest } from "../approval/approval-gate.js";

/**
 * Esc with vim keys on (ATO-662), through the real key layers. Ink hands
 * every keystroke to every `useInput` subscription, so the Esc vim spends
 * to leave INSERT also reaches the app's global Esc meanings unless they
 * stand down for it — these are the tests that would catch "x, Esc, 1"
 * aborting a turn.
 */
const SESSION: TuiSessionInfo = {
  sessionId: "s1",
  workingDir: "/tmp/smoke",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 1,
  maxSteps: 10,
  skillCount: 0,
};

const REQUEST: ApprovalRequest = {
  approvalId: "ap-1",
  sessionId: "s1",
  tool: "os.fs.write",
  category: "fs_write_workspace",
  reason: "replace 1337 bytes into /tmp/smoke/index.html",
  redirectablePath: "/tmp/smoke/index.html",
};

/** Ink holds a lone Esc for 20ms; every write waits past that window. */
const ESC = String.fromCharCode(27);
const UP = `${ESC}[A`;
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 60));

const strip = (value: string): string =>
  value.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");

interface Calls {
  aborts: number;
  decisions: Array<{ id: string; approved: boolean }>;
}

function harness() {
  const calls: Calls = { aborts: 0, decisions: [] };
  const callbacks: TuiAppCallbacks = {
    onApprovalDecision: (id, approved) => calls.decisions.push({ id, approved }),
    onAbort: () => {
      calls.aborts++;
    },
    onQuit: () => {},
    onMessageSubmitted: () => {},
  };
  const bus = makeTuiEventBus();
  const app = render(
    <TuiApp
      session={SESSION}
      bus={bus}
      callbacks={callbacks}
      initialLayout={{ vimMode: true }}
    />,
  );
  return { calls, bus, ...app };
}

describe("vim Esc and the global Esc meanings", () => {
  it("does not abort a running turn on x, Esc, 1", async () => {
    const { calls, bus, stdin, unmount } = harness();
    await settle();
    bus.emit({ type: "message_submitted" });
    await settle();

    stdin.write("x");
    await settle();
    // INSERT -> NORMAL: vim's Esc, so it must not arm the abort.
    stdin.write(ESC);
    await settle();
    stdin.write("1");
    await settle();
    expect(calls.aborts).toBe(0);

    // `1` is a pending count in NORMAL; this Esc drops it, still vim's.
    stdin.write(ESC);
    await settle();
    stdin.write("1");
    await settle();
    expect(calls.aborts).toBe(0);
    unmount();
  });

  it("still arms the abort on a bare Esc in NORMAL", async () => {
    const { calls, bus, stdin, unmount } = harness();
    await settle();
    bus.emit({ type: "message_submitted" });
    await settle();

    stdin.write(ESC); // INSERT -> NORMAL
    await settle();
    stdin.write(ESC); // NORMAL, nothing pending: arms
    await settle();
    stdin.write("1");
    await settle();
    expect(calls.aborts).toBe(1);
    unmount();
  });

  it("does not cancel context maintenance when Esc leaves INSERT", async () => {
    const { calls, bus, stdin, unmount } = harness();
    await settle();
    bus.emit({ type: "compaction_requested", sessionId: "s1" });
    await settle();

    stdin.write("x");
    await settle();
    stdin.write(ESC);
    await settle();
    expect(calls.aborts).toBe(0);
    unmount();
  });

  it("does not answer a pending approval with abort when Esc leaves INSERT", async () => {
    const { calls, bus, stdin, unmount } = harness();
    await settle();
    bus.emitApproval(REQUEST);
    await settle();

    // Empty draft: without vim this Esc is the "abort" answer.
    stdin.write(ESC);
    await settle();
    expect(calls.decisions).toHaveLength(0);
    expect(calls.aborts).toBe(0);

    // In NORMAL it is the answer again, as before.
    stdin.write(ESC);
    await settle();
    expect(calls.decisions).toEqual([{ id: "ap-1", approved: false }]);
    expect(calls.aborts).toBe(1);
    unmount();
  });
});

describe("Esc in vim NORMAL", () => {
  it("keeps the draft on one Esc with a pending approval; Esc Esc stashes it", async () => {
    const { calls, bus, stdin, lastFrame, unmount } = harness();
    await settle();
    bus.emitApproval(REQUEST);
    await settle();

    stdin.write("not yet");
    await settle();
    stdin.write(ESC); // INSERT -> NORMAL
    await settle();
    stdin.write(ESC); // bare NORMAL Esc: the draft stays, no verdict
    await settle();
    expect(strip(lastFrame() ?? "")).toContain("not yet");
    expect(calls.decisions).toHaveLength(0);
    expect(calls.aborts).toBe(0);

    stdin.write(ESC); // Esc Esc: cleared into history, still no verdict
    await settle();
    expect(strip(lastFrame() ?? "")).not.toContain("not yet");
    expect(calls.decisions).toHaveLength(0);
    expect(calls.aborts).toBe(0);

    stdin.write(UP);
    await settle();
    expect(strip(lastFrame() ?? "")).toContain("not yet");
    unmount();
  });

  it("is a no-op alone; Esc Esc clears the draft into history", async () => {
    const { calls, stdin, lastFrame, unmount } = harness();
    await settle();

    stdin.write("hello world");
    await settle();
    stdin.write(ESC); // INSERT -> NORMAL
    await settle();
    stdin.write(ESC); // bare Esc in NORMAL: nothing happens
    await settle();
    let frame = strip(lastFrame() ?? "");
    expect(frame).toContain("hello world");
    expect(calls.aborts).toBe(0);

    stdin.write(ESC); // the second of the pair: clear
    await settle();
    frame = strip(lastFrame() ?? "");
    expect(frame).not.toContain("hello world");

    stdin.write(UP);
    await settle();
    expect(strip(lastFrame() ?? "")).toContain("hello world");
    unmount();
  });
});
