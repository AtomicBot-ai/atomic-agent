import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEmptySessionState,
  type ConversationTurn,
  type SessionState,
} from "../session/index.js";
import { FileCheckpointStore, fileCheckpointsRoot } from "../tools/os/fs/fs-checkpoint-store.js";

import { startTestHarness, type Harness } from "./test-harness.js";

describe("rewind and fork routes (ATO-1056, ATO-1058)", () => {
  let harness: Harness;
  beforeEach(async () => { harness = await startTestHarness(); });
  afterEach(async () => { vi.restoreAllMocks(); await harness.cleanup(); });

  const post = (path: string, body: unknown) => fetch(`${harness.baseUrl}/api/sessions/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

  /** q0 "make a.txt" (at 100) wrote a.txt; q1 "change it" (at 200) edited it, made b.txt and ran a shell command. */
  function seed(id = "rw-1"): { state: SessionState; a: string; b: string } {
    const a = join(harness.workingDir, "a.txt");
    const b = join(harness.workingDir, "b.txt");
    const turns: ConversationTurn[] = [
      { kind: "user", text: "make a.txt", at: 100 },
      { kind: "assistant_tool_call", tool: "os.fs.write", args: { path: "a.txt" }, at: 110 },
      { kind: "tool_result", tool: "os.fs.write", status: "ok", summary: "ok", at: 120 },
      { kind: "assistant_reply", text: "made it", at: 130 },
      { kind: "user", text: "change it", at: 200 },
      { kind: "assistant_tool_call", tool: "os.fs.edit", args: { path: "a.txt" }, at: 210 },
      { kind: "tool_result", tool: "os.fs.edit", status: "ok", summary: "ok", at: 220 },
      { kind: "assistant_tool_call", tool: "os.shell.run", args: { command: "ls" }, at: 230 },
      { kind: "tool_result", tool: "os.shell.run", status: "ok", summary: "ok", at: 240 },
      { kind: "assistant_reply", text: "changed", at: 250 },
    ];
    const state: SessionState = {
      ...createEmptySessionState({ id, workingDir: harness.workingDir }),
      status: "completed",
      turns,
      turnCount: 2,
      macroTurnStarts: [4, 10],
    };
    harness.runtime.sessionStore.save(state);
    return { state, a, b };
  }

  /** Replays the file side of `seed` through the checkpoint store, as the tools would. */
  async function replayFiles(id: string, a: string, b: string): Promise<void> {
    let clock = 110;
    const store = new FileCheckpointStore(fileCheckpointsRoot(harness.runtime.config.paths.stateDir), () => clock);
    await store.capture(id, a, "os.fs.write");
    writeFileSync(a, "v1");
    clock = 210;
    await store.capture(id, a, "os.fs.edit");
    writeFileSync(a, "v2");
    await store.capture(id, b, "os.fs.write");
    writeFileSync(b, "new");
  }

  it("lists the questions it can go back to, newest first", async () => {
    seed();
    const res = await fetch(`${harness.baseUrl}/api/sessions/rw-1/rewind-points`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "rw-1",
      points: [
        { turnIndex: 4, priorQuestions: 1, text: "change it", at: 200 },
        { turnIndex: 0, priorQuestions: 0, text: "make a.txt", at: 100 },
      ],
    });
  });

  it("previews the files that will change, the messages removed and the shell calls that stay", async () => {
    const { a, b } = seed();
    await replayFiles("rw-1", a, b);
    const res = await post("rw-1/rewind/preview", { priorQuestions: 1, expectText: "change it" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "rw-1",
      turnIndex: 4,
      text: "change it",
      removed: { questions: 1, replies: 1 },
      files: [{ path: a, action: "restore" }, { path: b, action: "delete" }],
      notRestorable: [],
      incomplete: false,
      uncovered: [{ tool: "os.shell.run", count: 1 }],
    });
    // A preview changes nothing.
    expect(readFileSync(a, "utf8")).toBe("v2");
    expect(harness.runtime.sessionStore.load("rw-1")?.turns).toHaveLength(10);
  });

  it("rolls back files first, then the chat", async () => {
    const { a, b } = seed();
    await replayFiles("rw-1", a, b);
    const cancel = vi.spyOn(harness.runtime, "cancelSessionCompaction");
    const res = await post("rw-1/rewind", { priorQuestions: 1, expectText: "change it" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "rw-1", text: "change it", restored: [a], deleted: [b], failed: [], notRestorable: [], incomplete: false,
    });
    expect(readFileSync(a, "utf8")).toBe("v1");
    expect(existsSync(b)).toBe(false);
    const after = harness.runtime.sessionStore.load("rw-1");
    expect(after?.turns).toHaveLength(4);
    expect(after?.turnCount).toBe(1);
    expect(cancel).toHaveBeenCalledWith("rw-1");
    // Going back to the very start now restores only the first write.
    const again = await post("rw-1/rewind/preview", { priorQuestions: 0, expectText: "make a.txt" });
    expect(((await again.json()) as { files: unknown }).files).toEqual([{ path: a, action: "delete" }]);
  });

  it("takes back only the conversation with files: false", async () => {
    const { a, b } = seed();
    await replayFiles("rw-1", a, b);
    const res = await post("rw-1/rewind", { priorQuestions: 1, expectText: "change it", files: false });
    expect(res.status).toBe(200);
    expect(readFileSync(a, "utf8")).toBe("v2");
    expect(harness.runtime.sessionStore.load("rw-1")?.turns).toHaveLength(4);
  });

  it("refuses a question that is not the one given, while a turn runs, and for an unknown chat", async () => {
    const { a, b } = seed();
    await replayFiles("rw-1", a, b);
    const mismatch = await post("rw-1/rewind", { priorQuestions: 1, expectText: "something else" });
    expect(mismatch.status).toBe(409);
    expect(await codeOf(mismatch)).toBe("point_mismatch");
    expect((await post("rw-1/rewind", { priorQuestions: -1, expectText: "x" })).status).toBe(400);
    expect((await post("rw-1/rewind", { priorQuestions: 0 })).status).toBe(400);
    vi.spyOn(harness.runtime.turnController, "isBusy").mockImplementation((id: string) => id === "rw-1");
    const busy = await post("rw-1/rewind", { priorQuestions: 1, expectText: "change it" });
    expect(busy.status).toBe(409);
    expect(await codeOf(busy)).toBe("turn_in_progress");
    expect(readFileSync(a, "utf8")).toBe("v2");
    expect(harness.runtime.sessionStore.load("rw-1")?.turns).toHaveLength(10);
    const missing = await post("nope/fork", { priorQuestions: 0, expectText: "x" });
    expect(missing.status).toBe(404);
    expect(await codeOf(missing)).toBe("session_not_found");
  });

  it("forks a new chat through the picked question's answer and leaves the source alone", async () => {
    seed();
    const res = await post("rw-1/fork", { priorQuestions: 0, expectText: "make a.txt" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; title: string; sourceId: string };
    expect(body.sourceId).toBe("rw-1");
    expect(body.id).not.toBe("rw-1");
    expect(body.title).toBe("make a.txt (fork)");
    const fork = harness.runtime.sessionStore.load(body.id);
    expect(fork?.turns.map((t) => t.kind)).toEqual(["user", "assistant_tool_call", "tool_result", "assistant_reply"]);
    expect(harness.runtime.sessionStore.load("rw-1")?.turns).toHaveLength(10);
  });
});
