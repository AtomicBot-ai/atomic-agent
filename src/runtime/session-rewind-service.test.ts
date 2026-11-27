import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationTurn } from "../session/conversation-turn.js";
import { createEmptySessionState, type SessionState } from "../session/session-state.js";
import { FileCheckpointStore, fileCheckpointsRoot } from "../tools/os/fs/fs-checkpoint-store.js";
import {
  applySessionRewind,
  previewSessionRewind,
  sessionRewindDeps,
  type SessionRewindDeps,
} from "./session-rewind-service.js";

/**
 * The rewind every frontend shares (ATO-2467): the HTTP routes and the
 * terminal's `/rewind` call these, so "Chat and files", "Chat only" and
 * "Files only" do the same thing in both.
 */
describe("session rewind service (ATO-2467)", () => {
  let stateDir: string;
  let work: string;
  let clock: number;
  let checkpoints: FileCheckpointStore;
  let save: ReturnType<typeof vi.fn>;
  let clearTurnProgress: ReturnType<typeof vi.fn>;
  let cancel: ReturnType<typeof vi.fn>;
  let deps: SessionRewindDeps;
  let a: string;
  let b: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "aa-rwsvc-state-"));
    work = mkdtempSync(join(tmpdir(), "aa-rwsvc-work-"));
    clock = 110;
    checkpoints = new FileCheckpointStore(fileCheckpointsRoot(stateDir), () => clock);
    save = vi.fn();
    clearTurnProgress = vi.fn();
    cancel = vi.fn(() => false);
    deps = { sessionStore: { save, clearTurnProgress }, cancelSessionCompaction: cancel, checkpoints };
    a = join(work, "a.txt");
    b = join(work, "b.txt");
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  /** q0 "make a.txt" (at 100) wrote a.txt; q1 "change it" (at 200) edited it, made b.txt and ran a shell command. */
  function session(): SessionState {
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
    return {
      ...createEmptySessionState({ id: "rw-1", workingDir: work }),
      status: "completed",
      turns,
      turnCount: 2,
      macroTurnStarts: [4, 10],
    };
  }

  /** The file side of `session()`, captured as the tools would. */
  async function replayFiles(): Promise<void> {
    clock = 110;
    await checkpoints.capture("rw-1", a, "os.fs.write");
    writeFileSync(a, "v1");
    clock = 210;
    await checkpoints.capture("rw-1", a, "os.fs.edit");
    writeFileSync(a, "v2");
    await checkpoints.capture("rw-1", b, "os.fs.write");
    writeFileSync(b, "new");
  }

  it("previews the files that would change, the messages removed and the calls whose changes stay", async () => {
    await replayFiles();
    const preview = await previewSessionRewind(deps, session(), 4, "change it");
    expect(preview).toEqual({
      ok: true,
      value: {
        turnIndex: 4,
        text: "change it",
        removed: { questions: 1, replies: 1 },
        files: [{ path: a, action: "restore" }, { path: b, action: "delete" }],
        notRestorable: [],
        incomplete: false,
        uncovered: [{ tool: "os.shell.run", count: 1 }],
      },
    });
    expect(readFileSync(a, "utf8")).toBe("v2");
    expect(save).not.toHaveBeenCalled();
  });

  it("previews no files for a point the agent changed nothing after", async () => {
    const preview = await previewSessionRewind(deps, session(), 4);
    expect(preview.ok && preview.value.files).toEqual([]);
  });

  it("all: puts the files back, then cuts and saves the chat and forgets the copies after the point", async () => {
    await replayFiles();
    const done = await applySessionRewind(deps, session(), 4, "all", "change it");
    if (!done.ok) throw new Error(done.code);
    expect(done.value).toMatchObject({ text: "change it", restored: [a], deleted: [b], failed: [] });
    expect(readFileSync(a, "utf8")).toBe("v1");
    expect(existsSync(b)).toBe(false);
    expect(done.value.state?.turns).toHaveLength(4);
    expect(save).toHaveBeenCalledWith(done.value.state);
    expect(clearTurnProgress).toHaveBeenCalledWith("rw-1");
    expect(cancel).toHaveBeenCalledWith("rw-1");
    const again = await previewSessionRewind(deps, session(), 0);
    expect(again.ok && again.value.files).toEqual([{ path: a, action: "delete" }]);
  });

  it("conversation: cuts the chat and leaves the files as they are", async () => {
    await replayFiles();
    const done = await applySessionRewind(deps, session(), 4, "conversation");
    if (!done.ok) throw new Error(done.code);
    expect(done.value).toMatchObject({ restored: [], deleted: [], failed: [], notRestorable: [], incomplete: false });
    expect(readFileSync(a, "utf8")).toBe("v2");
    expect(existsSync(b)).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("files: puts the files back and leaves the chat and its copies alone", async () => {
    await replayFiles();
    const done = await applySessionRewind(deps, session(), 4, "files");
    if (!done.ok) throw new Error(done.code);
    expect(done.value).toMatchObject({ state: null, restored: [a], deleted: [b], failed: [] });
    expect(readFileSync(a, "utf8")).toBe("v1");
    expect(save).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    const again = await previewSessionRewind(deps, session(), 0);
    expect(again.ok && again.value.files).toEqual([{ path: a, action: "delete" }]);
  });

  it("reports a file it could not put back and still restores the rest", async () => {
    await replayFiles();
    // The saved copy of a.txt is gone: reading it fails, deleting b.txt still works.
    const dir = join(fileCheckpointsRoot(stateDir), "rw-1");
    for (const name of readdirSync(dir)) if (name.endsWith(".bin")) rmSync(join(dir, name));
    const done = await applySessionRewind(deps, session(), 4, "files");
    if (!done.ok) throw new Error(done.code);
    expect(done.value.failed.map((f) => f.path)).toEqual([a]);
    expect(done.value.deleted).toEqual([b]);
    expect(readFileSync(a, "utf8")).toBe("v2");
  });

  it("refuses a point that is not the question given and changes nothing", async () => {
    await replayFiles();
    expect(await applySessionRewind(deps, session(), 4, "all", "something else")).toEqual({
      ok: false,
      code: "point_mismatch",
    });
    expect(await previewSessionRewind(deps, session(), 5)).toEqual({ ok: false, code: "point_mismatch" });
    expect(readFileSync(a, "utf8")).toBe("v2");
    expect(save).not.toHaveBeenCalled();
  });

  it("reads the runtime at call time and keeps the checkpoints under its state dir", async () => {
    const runtime = {
      sessionStore: { save, clearTurnProgress },
      cancelSessionCompaction: vi.fn(() => true),
      config: { paths: { stateDir } },
    };
    const fromRuntime = sessionRewindDeps(runtime as unknown as Parameters<typeof sessionRewindDeps>[0]);
    await replayFiles();
    const later = vi.fn(() => true);
    runtime.cancelSessionCompaction = later;
    const done = await applySessionRewind(fromRuntime, session(), 4, "all");
    expect(done.ok && done.value.restored).toEqual([a]);
    expect(later).toHaveBeenCalledWith("rw-1");
  });
});
