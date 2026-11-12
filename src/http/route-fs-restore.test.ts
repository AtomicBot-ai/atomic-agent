import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptySessionState } from "../session/index.js";
import { FileRestoreStore } from "../tools/os/fs/fs-restore-store.js";

import { startTestHarness, type Harness } from "./test-harness.js";

describe("POST /api/sessions/{id}/fs/restore (ATO-563)", () => {
  let harness: Harness;
  beforeEach(async () => { harness = await startTestHarness(); });
  afterEach(async () => { vi.restoreAllMocks(); await harness.cleanup(); });

  const post = (id: string, body: unknown) => fetch(`${harness.baseUrl}/api/sessions/${id}/fs/restore`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  const store = () => new FileRestoreStore(resolve(harness.runtime.config.paths.stateDir, "restore"));

  function seed(id: string, status: "completed" | "running" = "completed"): void {
    harness.runtime.sessionStore.save({
      ...createEmptySessionState({ id, workingDir: harness.workingDir }),
      status,
    });
  }

  it("writes back the copy saved before the agent replaced the file, and keeps the copy", async () => {
    const file = join(harness.workingDir, "notes.txt");
    writeFileSync(file, "the agent's version\n");
    await store().saveCopy(harness.workingDir, file, "the user's version\nline two\n", {
      tool: "os.fs.write", lines: 2, sessionId: "fr-1",
    });
    seed("fr-1");
    const res = await post("fr-1", { path: file });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ path: file, lines: 2, savedBefore: "os.fs.write" });
    expect(readFileSync(file, "utf8")).toBe("the user's version\nline two\n");
    // A second revert still finds it, like os.fs.restore.
    expect(await store().latestCopy(harness.workingDir, file)).not.toBeNull();
  });

  it("refuses a file nothing was saved for, and leaves it as it is", async () => {
    const file = join(harness.workingDir, "edited.txt");
    writeFileSync(file, "after an ordinary edit\n");
    seed("fr-2");
    const res = await post("fr-2", { path: file });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("no_copy");
    expect(readFileSync(file, "utf8")).toBe("after an ordinary edit\n");
  });

  it("refuses a relative path and an unknown chat", async () => {
    seed("fr-3");
    expect((await post("fr-3", { path: "notes.txt" })).status).toBe(400);
    expect((await post("fr-3", {})).status).toBe(400);
    const missing = await post("no-such-chat", { path: join(harness.workingDir, "x.txt") });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("session_not_found");
  });

  it("waits for a running turn, whose tools may be writing the same file", async () => {
    const file = join(harness.workingDir, "busy.txt");
    writeFileSync(file, "new\n");
    await store().saveCopy(harness.workingDir, file, "old\n", { tool: "os.fs.write", lines: 1, sessionId: "fr-4" });
    seed("fr-4", "running");
    const res = await post("fr-4", { path: file });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("turn_in_progress");
    expect(readFileSync(file, "utf8")).toBe("new\n");
  });

  it("does not reach a copy saved for another working folder", async () => {
    const file = join(harness.workingDir, "other.txt");
    writeFileSync(file, "current\n");
    await store().saveCopy("/somewhere/else", file, "old\n", { tool: "os.fs.write", lines: 1, sessionId: "fr-5" });
    seed("fr-5");
    const res = await post("fr-5", { path: file });
    expect(res.status).toBe(404);
    expect(readFileSync(file, "utf8")).toBe("current\n");
  });
});
