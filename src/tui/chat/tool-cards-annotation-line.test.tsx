import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { fakeSession } from "../test-fixtures.js";
import { renderAtSize } from "../test-sized-render.js";
import { theme } from "../theme/theme.js";
import {
  createInitialTuiState,
  type ToolCardEntry,
  type TuiState,
} from "../tui-state.js";
import { ChatLog } from "./chat-log.js";
import { estimateMessageHeight } from "./chat-message-height.js";

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
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b\]8;;[^\u0007]*\u0007/g, "");
}

let seq = 0;
function card(
  tool: string,
  args: Record<string, unknown> = {},
  status: ToolCardEntry["status"] = "ok",
): ToolCardEntry {
  seq += 1;
  return {
    id: `tc-${seq}`,
    stepIndex: seq,
    tool,
    args,
    status,
    summary: "ok",
    truncated: false,
    startedAt: 1,
    finishedAt: 2,
  };
}

function withCards(cards: readonly ToolCardEntry[]): TuiState {
  return {
    ...createInitialTuiState(SESSION),
    messages: [
      {
        id: "m1",
        role: "assistant",
        text: "all done",
        toolSteps: cards.length,
        toolCards: cards,
        timestamp: 1,
      },
    ],
  };
}

describe("ToolCardsAnnotationLine in the transcript", () => {
  it("draws one line between the tool cards and the reply", () => {
    const app = render(
      <ChatLog
        state={withCards([
          card("os.fs.read", { path: "a.ts" }),
          card("os.fs.read", { path: "b.ts" }),
          card("os.shell.run", { command: "npm test" }),
        ])}
      />,
    );
    const lines = strip(app.lastFrame() ?? "").split("\n");
    const at = lines.findIndex((l) => l.includes("read 2 files, ran 1 command"));
    expect(at).toBeGreaterThan(-1);
    expect(lines[at]!.trim()).toBe(
      `${theme.glyphs.dotSeparator} read 2 files, ran 1 command`,
    );
    // Under the last card, above the reply.
    const lastCard = lines.findIndex((l) => l.includes("os.shell.run"));
    const reply = lines.findIndex((l) => l.includes("all done"));
    expect(lastCard).toBeLessThan(at);
    expect(at).toBeLessThan(reply);
    app.unmount();
  });

  it("draws nothing under a single card", () => {
    const app = render(
      <ChatLog state={withCards([card("os.shell.run", { command: "ls" })])} />,
    );
    const text = strip(app.lastFrame() ?? "");
    expect(text).toContain("os.shell.run");
    expect(text).not.toContain("ran 1 command");
    app.unmount();
  });

  it("truncates to one row at the 83-column chat width instead of wrapping", () => {
    const cards = [
      card("os.fs.read", { path: "a.ts" }),
      card("os.fs.grep", { pattern: "x" }),
      card("os.fs.edit", { path: "b.ts" }),
      card("os.shell.run", { command: "npm test" }),
      card("os.git.status"),
      card("browser.navigate", { url: "https://example.com" }),
      card("memory.notes.recall", { query: "q" }),
      card("tasks.list"),
    ];
    const full =
      "read 1 file, ran 1 search, edited 1 file, ran 1 command, ran 1 git command, 1 web step, 1 memory call, 1 other tool call";
    expect(full.length).toBeGreaterThan(83);
    const app = renderAtSize(<ChatLog state={withCards(cards)} />, {
      columns: 83,
      rows: 60,
    });
    const lines = strip(app.lastFrame() ?? "").split("\n");
    const hits = lines.filter((l) => l.includes("read 1 file, ran 1 search"));
    expect(hits).toHaveLength(1);
    const line = hits[0]!.trimEnd();
    expect(line.length).toBeLessThanOrEqual(83);
    expect(line.endsWith("…")).toBe(true);
    // The tail that did not fit is gone, not wrapped onto the next row.
    expect(lines.some((l) => l.includes("other tool call"))).toBe(false);
    app.unmount();
  });

  it("keeps the failure count when a 60-column terminal truncates the list", () => {
    const cards = [
      card("os.fs.read", { path: "a.ts" }),
      card("os.fs.grep", { pattern: "x" }),
      card("os.fs.edit", { path: "b.ts" }),
      card("os.shell.run", { command: "npm test" }),
      card("os.git.status"),
      card("os.web.search", { query: "q" }),
      card("os.shell.run", { command: "false" }, "error"),
      card("os.fs.edit", { path: "c.ts" }, "error"),
    ];
    const app = renderAtSize(<ChatLog state={withCards(cards)} />, {
      columns: 60,
      rows: 60,
    });
    const lines = strip(app.lastFrame() ?? "").split("\n");
    const hits = lines.filter((l) => l.includes("read 1 file"));
    expect(hits).toHaveLength(1);
    const line = hits[0]!.trimEnd();
    expect(line.length).toBeLessThanOrEqual(60);
    expect(line).toContain("…");
    expect(line.endsWith("· 2 failed")).toBe(true);
    // Nothing spilled onto a second row.
    expect(lines.filter((l) => l.includes("failed"))).toHaveLength(1);
    expect(lines.some((l) => l.includes("web step"))).toBe(false);
    app.unmount();
  });

  it("charges one row for a line that is only failures", () => {
    const failedOnly = withCards([
      card("os.shell.run", { command: "false" }, "error"),
      card("os.shell.run", { command: "false" }, "error"),
    ]);
    const app = render(<ChatLog state={failedOnly} />);
    const lines = strip(app.lastFrame() ?? "").split("\n");
    const hits = lines.filter((l) => l.includes("2 failed"));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.trim()).toBe(`${theme.glyphs.dotSeparator} 2 failed`);
    app.unmount();
  });

  it("is charged as exactly one row by the height estimate", () => {
    const one = withCards([card("os.shell.run", { command: "ls" })])
      .messages[0]!;
    const two = withCards([
      card("os.shell.run", { command: "ls" }),
      card("os.shell.run", { command: "pwd" }),
    ]).messages[0]!;
    const cardRows = 2;
    expect(estimateMessageHeight(two)).toBe(
      estimateMessageHeight(one) + cardRows + 1,
    );
  });
});
