import { fakeSession } from "../test-fixtures.js";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { ClipboardProvider } from "../clipboard/clipboard-context.js";
import type { ClipboardWriter } from "../clipboard/copy-to-clipboard.js";
import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { MouseProvider } from "../mouse/mouse-context.js";
import { MouseTargetRegistry } from "../mouse/mouse-registry.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import {
  createInitialTuiState,
  type StreamingToolCall,
  type ToolCardEntry,
  type TuiSessionInfo,
} from "../tui-state.js";
import { ToolCard } from "./tool-card.js";
import { toolCardFilePath } from "./tool-card-path-chip.js";

const SESSION: TuiSessionInfo = fakeSession({
  sessionId: "path-chip",
  workingDir: "/tmp/path-chip",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
});

function strip(value: string): string {
  return value.replace(/\[[0-9;]*m/g, "");
}

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

function noopCallbacks(): TuiAppCallbacks {
  return {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {},
    onMessageSubmitted: () => {},
  };
}

function finishedCard(overrides: Partial<ToolCardEntry> = {}): ToolCardEntry {
  return {
    id: "card-1",
    stepIndex: 0,
    tool: "os.fs.read",
    args: { path: "src/app/main.ts" },
    status: "ok",
    summary: "read 42 lines",
    truncated: false,
    startedAt: 1_000,
    finishedAt: 1_012,
    ...overrides,
  };
}

function mount(card: ToolCardEntry | StreamingToolCall): {
  frame: () => string;
  clickAt: (needle: string) => void;
  copied: string[];
  dispatched: unknown[];
  unmount: () => void;
} {
  const registry = new MouseTargetRegistry();
  const state = createInitialTuiState(SESSION);
  const copied: string[] = [];
  const dispatched: unknown[] = [];
  const writer: ClipboardWriter = {
    copy: async (text: string) => {
      copied.push(text);
      return true;
    },
  };
  const tree: ReactElement = (
    <ClipboardProvider writer={writer}>
      <MouseProvider
        registry={registry}
        dispatch={(action) => {
          dispatched.push(action);
        }}
        callbacks={noopCallbacks()}
        getState={() => state}
      >
        <ToolCard card={card} expanded={false} />
      </MouseProvider>
    </ClipboardProvider>
  );
  const { lastFrame, unmount } = render(tree);
  const frame = (): string => strip(lastFrame() ?? "");
  return {
    frame,
    clickAt: (needle) => {
      const at = locate(frame(), needle);
      registry.dispatch(click(at.x, at.y));
    },
    copied,
    dispatched,
    unmount,
  };
}

describe("toolCardFilePath", () => {
  it("returns the path of a single-file read / write / edit", () => {
    for (const tool of ["os.fs.read", "os.fs.write", "os.fs.edit"]) {
      expect(toolCardFilePath({ tool, args: { path: " /a/b.ts " } })).toBe(
        "/a/b.ts",
      );
    }
  });

  it("prefers the file the tool actually touched over the requested one", () => {
    // A write the operator moved in the approval prompt: the model asked
    // for `notes.md`, the file landed elsewhere.
    expect(
      toolCardFilePath({
        tool: "os.fs.write",
        args: { path: "notes.md" },
        details: { path: "/home/me/elsewhere/notes.md" },
      }),
    ).toBe("/home/me/elsewhere/notes.md");
    // No usable detail (failed call, replayed chat): fall back to args.
    expect(
      toolCardFilePath({
        tool: "os.fs.read",
        args: { path: "src/a.ts" },
        details: { size: 3 },
      }),
    ).toBe("src/a.ts");
  });

  it("offers nothing for other tools, missing or non-string paths", () => {
    expect(
      toolCardFilePath({ tool: "os.shell.run", args: { path: "/a" } }),
    ).toBeNull();
    expect(
      toolCardFilePath({ tool: "os.fs.trash", args: { paths: ["/a", "/b"] } }),
    ).toBeNull();
    expect(toolCardFilePath({ tool: "os.fs.read", args: {} })).toBeNull();
    expect(
      toolCardFilePath({ tool: "os.fs.read", args: { path: 42 } }),
    ).toBeNull();
    expect(
      toolCardFilePath({ tool: "os.fs.edit", args: { path: "   " } }),
    ).toBeNull();
  });
});

describe("ToolCard [copy path]", () => {
  it("copies the file path without folding the card", async () => {
    const app = mount(finishedCard());
    await waitUntil(
      () => app.frame().includes("[copy path]"),
      "the copy-path chip",
    );
    for (let attempt = 0; attempt < 40 && app.copied.length === 0; attempt += 1) {
      app.clickAt("[copy path]");
      await delay(25);
    }
    expect(app.copied).toEqual(["src/app/main.ts"]);
    expect(app.dispatched).toEqual([]);
    await waitUntil(
      () => app.frame().includes("[copied!]"),
      "the copied badge",
    );
    app.unmount();
  });

  it("keeps the header click as the expand toggle", async () => {
    const app = mount(finishedCard());
    await waitUntil(
      () => app.frame().includes("[copy path]"),
      "the copy-path chip",
    );
    for (
      let attempt = 0;
      attempt < 40 && app.dispatched.length === 0;
      attempt += 1
    ) {
      app.clickAt("os.fs.read");
      await delay(25);
    }
    expect(app.dispatched).toEqual([
      { type: "tool_expand_toggled", toolCardId: "card-1" },
    ]);
    expect(app.copied).toEqual([]);
    app.unmount();
  });

  it("shows no chip on an in-flight call or a non-file tool", async () => {
    const pending = mount({
      id: "card-2",
      stepIndex: 0,
      tool: "os.fs.read",
      args: { path: "src/app/main.ts" },
      startedAt: 1_000,
    });
    await waitUntil(
      () => pending.frame().includes("os.fs.read"),
      "the pending header",
    );
    expect(pending.frame()).not.toContain("[copy path]");
    pending.unmount();

    const shell = mount(
      finishedCard({ tool: "os.shell.run", args: { command: "ls" } }),
    );
    await waitUntil(
      () => shell.frame().includes("read 42 lines"),
      "the finished shell card",
    );
    expect(shell.frame()).not.toContain("[copy path]");
    shell.unmount();
  });

  it("copies the resolved path the tool reported, not the raw argument", async () => {
    const app = mount(
      finishedCard({
        tool: "os.fs.write",
        args: { path: "notes.md", content: "hi" },
        summary: "wrote 2 bytes",
        details: { path: "/tmp/path-chip/moved/notes.md" },
      }),
    );
    await waitUntil(
      () => app.frame().includes("[copy path]"),
      "the copy-path chip",
    );
    for (let attempt = 0; attempt < 40 && app.copied.length === 0; attempt += 1) {
      app.clickAt("[copy path]");
      await delay(25);
    }
    expect(app.copied).toEqual(["/tmp/path-chip/moved/notes.md"]);
    app.unmount();
  });
});
