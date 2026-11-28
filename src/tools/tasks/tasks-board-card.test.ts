import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskStore, type TaskRecord } from "../../tasks/index.js";
import type { ToolContext, ToolDefinition } from "../tool-registry.js";
import { buildBoardCardTools } from "./tasks-board-card.js";
import { BOARD_CARD_TOOLS, withBoardCardVisibility } from "./board-card-visibility.js";

function ctx(sessionId = "s-run"): ToolContext {
  return { workingDir: "/work", sessionId, stepIndex: 0, signal: new AbortController().signal };
}

/** ATO-2497: the agent moves and comments on the card of the task it runs. */
describe("board card tools", () => {
  let tmp: string;
  let store: TaskStore;
  let running: TaskRecord | null;
  let tools: Map<string, ToolDefinition>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-board-tools-"));
    store = new TaskStore({ dbFile: join(tmp, "tasks.sqlite") });
    running = null;
    const built = buildBoardCardTools({
      taskStore: store,
      runningTaskInSession: (sessionId) =>
        running && running.sessionId === sessionId ? running : null,
    });
    tools = new Map(built.map((tool) => [tool.name, tool]));
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const startTask = (): TaskRecord => {
    const t = store.create({ sessionId: "s-run", userMessage: "x", origin: "cli", maxAttempts: 1 });
    running = store.markRunning(t.id, 1_000);
    return running!;
  };
  const call = (name: string, args: Record<string, unknown>, sessionId?: string) =>
    tools.get(name)!.run(args, ctx(sessionId));
  const lane = (id: string) => store.boardCards().find((c) => c.task.id === id)?.lane;

  it("are the three board tools, in catalog order, declared readonly like plan.update", () => {
    expect([...tools.keys()]).toEqual(["tasks.request_review", "tasks.block", "tasks.comment"]);
    expect(new Set(tools.keys())).toEqual(BOARD_CARD_TOOLS);
    for (const tool of tools.values()) expect(tool.readonly, tool.name).toBe(true);
  });

  it("refuses outside a task run and changes nothing", async () => {
    const t = store.create({ sessionId: "s-chat", userMessage: "x", origin: "cli", maxAttempts: 1 });
    for (const name of tools.keys()) {
      const result = await call(name, { reason: "r", text: "t" }, "s-chat");
      expect(result.status, name).toBe("error");
      expect(result.details.notRunningTask, name).toBe(true);
    }
    expect(store.boardEntry(t.id)).toBeNull();
    expect(store.listBoardComments(t.id)).toEqual([]);
  });

  it("request_review moves the running card to Review and records the note", async () => {
    const t = startTask();
    const result = await call("tasks.request_review", { note: "check section 2" });
    expect(result.status).toBe("ok");
    expect(lane(t.id)).toBe("review");
    expect(store.get(t.id)?.status).toBe("running");
    expect(store.listBoardComments(t.id)[0]).toMatchObject({ author: "agent", kind: "review", text: "check section 2" });
  });

  it("request_review without a note still leaves a line in the history", async () => {
    const t = startTask();
    await call("tasks.request_review", {});
    expect(store.listBoardComments(t.id)[0]).toMatchObject({ kind: "review", text: "Ready for review." });
  });

  it("block needs a reason, then moves the card to Blocked with it", async () => {
    const t = startTask();
    const missing = await call("tasks.block", {});
    expect(missing.status).toBe("error");
    expect(missing.details.field).toBe("reason");
    expect(lane(t.id)).toBe("doing");

    const blocked = await call("tasks.block", { reason: "the API key is rejected" });
    expect(blocked.status).toBe("ok");
    expect(lane(t.id)).toBe("blocked");
    expect(store.listBoardComments(t.id)[0]).toMatchObject({ kind: "block", text: "the API key is rejected" });
  });

  it("comment adds to the thread without moving the card", async () => {
    const t = startTask();
    const empty = await call("tasks.comment", { text: "   " });
    expect(empty.status).toBe("error");
    await call("tasks.comment", { text: "halfway there" });
    expect(lane(t.id)).toBe("doing");
    expect(store.listBoardComments(t.id).map((c) => c.text)).toEqual(["halfway there"]);
  });
});

describe("withBoardCardVisibility", () => {
  it("hides the board tools from a turn that runs no task", () => {
    const filter = withBoardCardVisibility(undefined, false)!;
    for (const name of BOARD_CARD_TOOLS) expect(filter(name), name).toBe(false);
    expect(filter("tasks.list")).toBe(true);
  });

  it("keeps the caller's filter, and adds nothing on a task's run", () => {
    expect(withBoardCardVisibility(undefined, true)).toBeUndefined();
    const own = (name: string) => name !== "os.fs.write";
    expect(withBoardCardVisibility(own, true)).toBe(own);
    const composed = withBoardCardVisibility(own, false)!;
    expect(composed("os.fs.write")).toBe(false);
    expect(composed("tasks.block")).toBe(false);
    expect(composed("os.fs.read")).toBe(true);
  });
});
