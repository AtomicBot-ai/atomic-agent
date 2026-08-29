import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "./tui-app.js";
import type { TuiSessionInfo } from "./tui-state.js";
import type { ApprovalRequest } from "../approval/approval-gate.js";

/**
 * End-to-end through the real key layers: an approval prompt no longer
 * takes the keyboard hostage, and no longer has to. Ink delivers every
 * keystroke to every `useInput` subscription, so these are the tests
 * that would catch a `y` that is both a verdict and a character — which
 * is exactly what it used to be, arbitrated by whether the composer's
 * buffer happened to be empty.
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

/** Ink holds a lone Esc for 20ms; every read waits past that window. */
const ESC = String.fromCharCode(27);

/**
 * The decision chords as the bytes a terminal actually sends. Written
 * as control characters rather than as a synthesised `Key` because the
 * whole point of this file is to go through Ink's own parser: a chord
 * that this app claims but Ink reports differently would pass every
 * unit test and fail in a real terminal.
 */
const CTRL_Y = String.fromCharCode(25);
const CTRL_D = String.fromCharCode(4);
const CTRL_B = String.fromCharCode(2);
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 60));

/** Drop SGR colour runs so assertions read the plain text. */
const strip = (value: string): string =>
  value.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");

interface Calls {
  decisions: Array<{ id: string; approved: boolean }>;
  retargets: Array<{ id: string; path: string }>;
  replies: Array<{ id: string; message: string }>;
  aborts: number;
}

function harness() {
  const calls: Calls = { decisions: [], retargets: [], replies: [], aborts: 0 };
  const callbacks: TuiAppCallbacks = {
    onApprovalDecision: (id, approved) => calls.decisions.push({ id, approved }),
    onApprovalRetarget: (id, path) => calls.retargets.push({ id, path }),
    onApprovalReply: (id, message) => calls.replies.push({ id, message }),
    onAbort: () => {
      calls.aborts++;
    },
    onQuit: () => {},
    onMessageSubmitted: () => {},
  };
  const bus = makeTuiEventBus();
  const app = render(<TuiApp session={SESSION} bus={bus} callbacks={callbacks} />);
  return { calls, bus, ...app };
}

describe("approval prompt with a live composer", () => {
  it("types into the input instead of deciding, then sends on Enter", async () => {
    const { calls, bus, stdin, lastFrame, unmount } = harness();
    await settle();
    bus.emitApproval(REQUEST);
    await settle();

    // A message that opens with "y" must not approve the write.
    stdin.write("yes, put it in ~/Documents/apple-site");
    await settle();
    expect(calls.decisions).toHaveLength(0);
    expect(strip(lastFrame() ?? "")).toContain("~/Documents/apple-site");

    stdin.write("\r");
    await settle();
    expect(calls.replies).toEqual([
      { id: "ap-1", message: "yes, put it in ~/Documents/apple-site" },
    ]);
    // The reply IS the verdict, so no separate approve/deny fires.
    expect(calls.decisions).toHaveLength(0);
    unmount();
  });

  it("approves on ctrl+y, empty buffer or not", async () => {
    const { calls, bus, stdin, unmount } = harness();
    await settle();
    bus.emitApproval(REQUEST);
    await settle();

    // A bare `y` is a character now, in every state.
    stdin.write("y");
    await settle();
    expect(calls.decisions).toHaveLength(0);

    // And the chord decides straight through the draft that `y` left —
    // which the old buffer-arbitrated rule could not do.
    stdin.write(CTRL_Y);
    await settle();
    expect(calls.decisions).toEqual([{ id: "ap-1", approved: true }]);
    unmount();
  });

  it("denies on ctrl+d through a draft, and Esc still only clears it", async () => {
    const { calls, bus, stdin, lastFrame, unmount } = harness();
    await settle();
    bus.emitApproval(REQUEST);
    await settle();

    stdin.write("nope");
    await settle();
    expect(calls.decisions).toHaveLength(0);

    stdin.write(ESC);
    await settle();
    expect(strip(lastFrame() ?? "")).not.toContain("nope");
    // Esc cleared the draft; it must not have aborted the run. This is
    // the one binding the two layers still share, and the reason it can
    // stay shared is that it was never a verdict.
    expect(calls.aborts).toBe(0);

    stdin.write(CTRL_D);
    await settle();
    expect(calls.decisions).toEqual([{ id: "ap-1", approved: false }]);
    unmount();
  });

  it("ctrl+b opens the target field, and Enter confirms the typed path", async () => {
    const { calls, bus, stdin, lastFrame, unmount } = harness();
    await settle();
    bus.emitApproval(REQUEST);
    await settle();

    stdin.write(CTRL_B);
    await settle();
    const editing = strip(lastFrame() ?? "");
    expect(editing).toContain("confirm target path");
    // Seeded with the proposed target, so a small edit stays small.
    expect(editing).toContain("/tmp/smoke/index.html");

    stdin.write("2");
    await settle();
    stdin.write("\r");
    await settle();
    expect(calls.retargets).toEqual([
      { id: "ap-1", path: "/tmp/smoke/index.html2" },
    ]);
    unmount();
  });

  it("Esc in the target field returns to the prompt without deciding", async () => {
    const { calls, bus, stdin, lastFrame, unmount } = harness();
    await settle();
    bus.emitApproval(REQUEST);
    await settle();

    stdin.write(CTRL_B);
    await settle();
    stdin.write(ESC);
    await settle();
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("ctrl+y");
    expect(frame).not.toContain("confirm target path");
    expect(calls.decisions).toHaveLength(0);
    expect(calls.retargets).toHaveLength(0);
    expect(calls.aborts).toBe(0);
    unmount();
  });
});
