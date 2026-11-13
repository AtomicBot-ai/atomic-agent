import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INTERRUPTED_TURN_ENDING,
  INTERRUPTED_TURN_RESUME_NOTE,
  createEmptySessionState,
} from "../session/index.js";

import { startTestHarness, type Harness } from "./test-harness.js";

describe("POST /api/sessions/{id}/resume (ATO-448)", () => {
  let harness: Harness;
  beforeEach(async () => { harness = await startTestHarness(); });
  afterEach(async () => { vi.restoreAllMocks(); await harness.cleanup(); });

  const post = (id: string, body: unknown = {}) => fetch(`${harness.baseUrl}/api/sessions/${id}/resume`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  async function errorCode(res: Response): Promise<string> {
    return ((await res.json()) as { error: { code: string } }).error.code;
  }

  /** A chat whose turn the agent stopping cut off, as shutdown records it. */
  function seedInterrupted(id: string): void {
    const store = harness.runtime.sessionStore;
    store.save({
      ...createEmptySessionState({ id, workingDir: harness.workingDir }),
      turns: [{ kind: "user", text: "push the branch", at: 1 }],
    });
    expect(store.beginTurn(id, 1_000, {
      stepsDone: 0,
      lastStepIndex: -1,
      request: "push the branch",
      options: { interactive: true },
      resumes: 0,
      startedAt: 1_000,
      updatedAt: 1_000,
    })).toBe(true);
    expect(store.releaseTurn(id, INTERRUPTED_TURN_ENDING)).toBe(true);
  }

  it("hands out the continuing message for a chat a restart cut off, once", async () => {
    seedInterrupted("rs-1");
    const res = await post("rs-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; text: string };
    expect(body.id).toBe("rs-1");
    expect(body.text).toContain(INTERRUPTED_TURN_RESUME_NOTE);
    expect(body.text.endsWith("push the branch")).toBe(true);

    const again = await post("rs-1");
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("nothing_to_resume");
  });

  it("offers it again after the client releases a message it could not send", async () => {
    seedInterrupted("rs-2");
    const first = (await (await post("rs-2")).json()) as { text: string };
    const released = await post("rs-2", { release: true });
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ id: "rs-2", released: true });
    const again = await post("rs-2");
    expect(again.status).toBe(200);
    expect(((await again.json()) as { text: string }).text).toBe(first.text);
  });

  it("answers 409 nothing_to_resume on a chat whose last turn was not cut off", async () => {
    harness.runtime.sessionStore.save({
      ...createEmptySessionState({ id: "rs-3", workingDir: harness.workingDir }),
      status: "completed",
      turns: [
        { kind: "user", text: "hi", at: 1 },
        { kind: "assistant_reply", text: "hello", at: 2 },
      ],
    });
    const res = await post("rs-3");
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("nothing_to_resume");
  });

  it("starts nothing on its own", async () => {
    seedInterrupted("rs-4");
    const runTurn = vi.spyOn(harness.runtime, "runTurn");
    expect((await post("rs-4")).status).toBe(200);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("answers 409 turn_in_progress while the chat runs a turn", async () => {
    seedInterrupted("rs-5");
    vi.spyOn(harness.runtime.turnController, "isBusy").mockImplementation((id: string) => id === "rs-5");
    const res = await post("rs-5");
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("turn_in_progress");
  });

  it("answers 404 session_not_found for an unknown chat", async () => {
    const res = await post("rs-missing");
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("session_not_found");
  });

  it("rejects a release that is not a boolean", async () => {
    seedInterrupted("rs-6");
    expect((await post("rs-6", { release: "yes" })).status).toBe(400);
  });
});
