import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEmptySessionState, type SessionState } from "../session/index.js";
import { TaskRunner } from "./task-runner.js";
import { TaskStore } from "./task-store.js";

/**
 * ATO-592: a drain holds the keep-awake for exactly as long as it runs,
 * releases it when a turn throws, and takes no hold when nothing is due.
 */
describe("TaskRunner keep-awake hold", () => {
  let tmp: string;
  let store: TaskStore;
  let session: SessionState;
  let events: string[];

  const keepAwake = {
    hold: () => {
      events.push("hold");
      return () => {
        events.push("release");
      };
    },
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-keep-awake-"));
    store = new TaskStore({ dbFile: join(tmp, "tasks.sqlite") });
    session = createEmptySessionState({ id: "s-1", workingDir: "/tmp/work" });
    events = [];
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function runner(fail = false): TaskRunner {
    return new TaskRunner({
      store,
      runtime: {
        runTurn: async (s) => {
          events.push("turn");
          if (fail) throw new Error("boom");
          return { session: s, reason: "reply", stepCount: 1 };
        },
      },
      sessionLoader: { load: () => session },
      defaultMaxSteps: 5,
      backoff: { initialMs: 0, maxMs: 0 },
      enabled: true,
      runOnCreate: false,
      sleep: async () => {},
      keepAwake,
    });
  }

  function dueTask(): string {
    return store.create({
      sessionId: session.id,
      userMessage: "nightly report",
      origin: "cli",
      maxAttempts: 1,
      scheduledFor: 1_000,
    }).id;
  }

  it("holds around a due drain", async () => {
    dueTask();
    const outcome = await runner().runDue(Date.now(), 10);
    expect(outcome.drained).toBe(1);
    expect(events).toEqual(["hold", "turn", "release"]);
  });

  it("releases even when the turn fails", async () => {
    dueTask();
    await runner(true).runDue(Date.now(), 10);
    expect(events[0]).toBe("hold");
    expect(events.at(-1)).toBe("release");
    expect(events.filter((e) => e === "release")).toHaveLength(1);
  });

  it("takes no hold when nothing is due", async () => {
    await runner().runDue(Date.now(), 10);
    await runner().drainPending();
    expect(events).toEqual([]);
  });
});
