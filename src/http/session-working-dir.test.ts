import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptySessionState } from "../session/index.js";

import { checkWorkingDir } from "./session-working-dir.js";
import { startTestHarness, type Harness } from "./test-harness.js";

describe("checkWorkingDir (ATO-731)", () => {
  it("takes an existing absolute folder and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-"));
    expect(checkWorkingDir(dir)).toEqual({ ok: true, dir });
    expect(checkWorkingDir("relative/path").ok).toBe(false);
    expect(checkWorkingDir(join(dir, "missing")).ok).toBe(false);
    expect(checkWorkingDir("").ok).toBe(false);
    expect(checkWorkingDir(42).ok).toBe(false);
  });
});

describe("POST /api/sessions/{id}/working-dir (ATO-731)", () => {
  let harness: Harness;
  beforeEach(async () => { harness = await startTestHarness(); });
  afterEach(async () => { vi.restoreAllMocks(); await harness.cleanup(); });

  const post = (id: string, workingDir: unknown) => fetch(`${harness.baseUrl}/api/sessions/${id}/working-dir`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workingDir }),
  });

  it("moves one chat to another folder, and lists it with scope=all", async () => {
    harness.runtime.sessionStore.save(createEmptySessionState({ id: "wd-1", workingDir: harness.workingDir }));
    const other = mkdtempSync(join(tmpdir(), "wd-other-"));
    const res = await post("wd-1", other);
    expect(res.status).toBe(200);
    expect(harness.runtime.sessionStore.load("wd-1")?.workingDir).toBe(other);
    const here = (await (await fetch(`${harness.baseUrl}/api/sessions`)).json()) as { sessions: Array<{ id: string }> };
    expect(here.sessions.map((s) => s.id)).not.toContain("wd-1");
    const all = (await (await fetch(`${harness.baseUrl}/api/sessions?scope=all`)).json()) as { sessions: Array<{ id: string }> };
    expect(all.sessions.map((s) => s.id)).toContain("wd-1");
  });

  it("refuses while that chat runs a turn, an unknown chat, and a bad folder", async () => {
    harness.runtime.sessionStore.save(createEmptySessionState({ id: "wd-2", workingDir: harness.workingDir }));
    vi.spyOn(harness.runtime.turnController, "isBusy").mockImplementation((id: string) => id === "wd-2");
    expect((await post("wd-2", harness.workingDir)).status).toBe(409);
    expect((await post("nope", harness.workingDir)).status).toBe(404);
    expect((await post("wd-2", "relative")).status).toBe(400);
  });

  it("refuses a chat another process runs a turn in", async () => {
    harness.runtime.sessionStore.save({ ...createEmptySessionState({ id: "wd-3", workingDir: harness.workingDir }), status: "running" });
    expect((await post("wd-3", harness.workingDir)).status).toBe(409);
  });
});
