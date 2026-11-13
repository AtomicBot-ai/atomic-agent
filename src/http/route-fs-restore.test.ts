import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptySessionState, type ConversationTurn } from "../session/index.js";
import {
  CHECKPOINT_MAX_AGE_MS,
  FileCheckpointStore,
  fileCheckpointsRoot,
} from "../tools/os/fs/fs-checkpoint-store.js";

import { startTestHarness, type Harness } from "./test-harness.js";

describe("POST /api/sessions/{id}/fs/restore (ATO-563, from the ATO-1056 checkpoints)", () => {
  let harness: Harness;
  beforeEach(async () => { harness = await startTestHarness(); });
  afterEach(async () => { vi.restoreAllMocks(); await harness.cleanup(); });

  const post = (id: string, body: unknown) => fetch(`${harness.baseUrl}/api/sessions/${id}/fs/restore`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

  let clock = 0;
  const store = () => new FileCheckpointStore(fileCheckpointsRoot(harness.runtime.config.paths.stateDir), () => clock);

  /** q0 "write notes" at 100 (its reply at 190), q1 "again" at 200 (reply at 290). */
  function seed(id: string, status: "completed" | "running" = "completed"): void {
    const turns: ConversationTurn[] = [
      { kind: "user", text: "write notes", at: 100 },
      { kind: "assistant_reply", text: "done", at: 190 },
      { kind: "user", text: "again", at: 200 },
      { kind: "assistant_reply", text: "done again", at: 290 },
    ];
    harness.runtime.sessionStore.save({
      ...createEmptySessionState({ id, workingDir: harness.workingDir }),
      status,
      turns,
      turnCount: 2,
      macroTurnStarts: [2, 4],
    });
  }

  /** What the agent's tool does: checkpoint, then write. */
  async function agentWrites(id: string, file: string, content: string, at: number): Promise<void> {
    clock = at;
    await store().capture(id, file, "os.fs.write");
    writeFileSync(file, content);
  }

  it("two writes in one reply: Revert puts back the content from before the reply, not the middle one", async () => {
    const file = join(harness.workingDir, "notes.txt");
    writeFileSync(file, "orig");
    await agentWrites("fr-1", file, "mid", 110);
    await agentWrites("fr-1", file, "final", 120);
    seed("fr-1");
    const res = await post("fr-1", { path: file, priorQuestions: 0, expectText: "write notes" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ path: file, action: "restore", at: 110, tool: "os.fs.write" });
    expect(readFileSync(file, "utf8")).toBe("orig");
    // The copies stay: a second Revert finds the file already as it was.
    const again = await post("fr-1", { path: file, priorQuestions: 0, expectText: "write notes" });
    expect(await again.json()).toMatchObject({ action: "unchanged" });
  });

  it("restores the second reply's own starting point, not the first reply's", async () => {
    const file = join(harness.workingDir, "two.txt");
    writeFileSync(file, "orig");
    await agentWrites("fr-2", file, "after q0", 110);
    await agentWrites("fr-2", file, "after q1", 210);
    seed("fr-2");
    const res = await post("fr-2", { path: file, priorQuestions: 1, expectText: "again" });
    expect(res.status).toBe(200);
    expect(readFileSync(file, "utf8")).toBe("after q0");
  });

  it("refuses when a later reply changed the same file, and leaves it as it is", async () => {
    const file = join(harness.workingDir, "later.txt");
    writeFileSync(file, "orig");
    await agentWrites("fr-3", file, "after q0", 110);
    await agentWrites("fr-3", file, "after q1", 210);
    seed("fr-3");
    const res = await post("fr-3", { path: file, priorQuestions: 0, expectText: "write notes" });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("changed_later");
    expect(readFileSync(file, "utf8")).toBe("after q1");
  });

  it("refuses a file that reply left no snapshot of", async () => {
    const file = join(harness.workingDir, "untouched.txt");
    writeFileSync(file, "as the user left it");
    const other = join(harness.workingDir, "other.txt");
    await agentWrites("fr-4", other, "x", 110);
    seed("fr-4");
    const res = await post("fr-4", { path: file, priorQuestions: 0, expectText: "write notes" });
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe("no_snapshot");
    expect(readFileSync(file, "utf8")).toBe("as the user left it");
    // A snapshot from the next reply is not this reply's.
    const next = await post("fr-4", { path: other, priorQuestions: 1, expectText: "again" });
    expect(await codeOf(next)).toBe("no_snapshot");
  });

  it("removes a file the reply created, as the rewind does", async () => {
    const file = join(harness.workingDir, "new.txt");
    await agentWrites("fr-5", file, "made by the agent", 110);
    seed("fr-5");
    const res = await post("fr-5", { path: file, priorQuestions: 0, expectText: "write notes" });
    expect(await res.json()).toMatchObject({ action: "delete" });
    expect(existsSync(file)).toBe(false);
  });

  it("refuses a question that is not the one given, a missing selector, a relative path and an unknown chat", async () => {
    const file = join(harness.workingDir, "sel.txt");
    writeFileSync(file, "orig");
    await agentWrites("fr-6", file, "new", 110);
    seed("fr-6");
    const wrong = await post("fr-6", { path: file, priorQuestions: 0, expectText: "again" });
    expect(wrong.status).toBe(409);
    expect(await codeOf(wrong)).toBe("point_mismatch");
    expect((await post("fr-6", { path: file })).status).toBe(400);
    expect((await post("fr-6", { path: file, priorQuestions: 0 })).status).toBe(400);
    expect((await post("fr-6", { path: "sel.txt", priorQuestions: 0, expectText: "write notes" })).status).toBe(400);
    const missing = await post("no-such-chat", { path: file, priorQuestions: 0, expectText: "write notes" });
    expect(missing.status).toBe(404);
    expect(await codeOf(missing)).toBe("session_not_found");
    expect(readFileSync(file, "utf8")).toBe("new");
  });

  it("waits for a running turn, whose tools may be writing the same file", async () => {
    const file = join(harness.workingDir, "busy.txt");
    writeFileSync(file, "old");
    await agentWrites("fr-7", file, "new", 110);
    seed("fr-7", "running");
    const res = await post("fr-7", { path: file, priorQuestions: 0, expectText: "write notes" });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("turn_in_progress");
    expect(readFileSync(file, "utf8")).toBe("new");
  });

  it("a chat's snapshots are pruned 30 days after its last one, then Revert says so", async () => {
    const root = fileCheckpointsRoot(harness.runtime.config.paths.stateDir);
    const oldFile = join(harness.workingDir, "old.txt");
    const recentFile = join(harness.workingDir, "recent.txt");
    writeFileSync(oldFile, "orig");
    writeFileSync(recentFile, "orig");
    await agentWrites("fr-old", oldFile, "new", 110);
    await agentWrites("fr-recent", recentFile, "new", 110);
    seed("fr-old");
    seed("fr-recent");
    // The last snapshot of fr-old was 31 days ago, of fr-recent 29 days ago.
    const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);
    utimesSync(join(root, "fr-old", "index.json"), daysAgo(31), daysAgo(31));
    utimesSync(join(root, "fr-recent", "index.json"), daysAgo(29), daysAgo(29));
    expect(CHECKPOINT_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1000);
    // The runtime's store prunes on its first capture (any chat).
    const live = new FileCheckpointStore(root);
    await live.capture("fr-other", join(harness.workingDir, "x.txt"), "os.fs.write");
    expect(existsSync(join(root, "fr-old"))).toBe(false);
    expect(existsSync(join(root, "fr-recent"))).toBe(true);
    const gone = await post("fr-old", { path: oldFile, priorQuestions: 0, expectText: "write notes" });
    expect(gone.status).toBe(404);
    expect(await codeOf(gone)).toBe("no_snapshot");
    expect(readFileSync(oldFile, "utf8")).toBe("new");
    const kept = await post("fr-recent", { path: recentFile, priorQuestions: 0, expectText: "write notes" });
    expect(kept.status).toBe(200);
    expect(readFileSync(recentFile, "utf8")).toBe("orig");
  });
});
