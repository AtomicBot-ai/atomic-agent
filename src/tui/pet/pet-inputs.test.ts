import { describe, expect, it } from "vitest";

import { fakeSession } from "../test-fixtures.js";
import { createInitialTuiState, type RunHistoryEntry, type TuiState } from "../tui-state.js";
import { PetTuiDriver, petEndingOf, petInputsFromTui, petNewEnding } from "./pet-inputs.js";

const base = (): TuiState => createInitialTuiState(fakeSession());

function run(outcome: RunHistoryEntry["outcome"], finishedAt: number): RunHistoryEntry {
  return { message: "hi", outcome, reason: "", stepCount: 1, durationMs: 10, finishedAt };
}

const pendingCard = {
  id: "c1",
  stepIndex: 0,
  tool: "os.shell.exec",
  args: {},
  status: "pending" as const,
  summary: "",
  truncated: false,
  startedAt: 0,
  finishedAt: null,
};

describe("terminal pet inputs (ATO-2513)", () => {
  it("is quiet while nothing runs", () => {
    expect(petInputsFromTui(base())).toEqual({ activity: null, waiting: false });
  });

  it("thinks while a turn runs with no tool in flight, works while one is", () => {
    const running = { ...base(), status: "running" as const };
    expect(petInputsFromTui(running).activity).toBe("thinking");
    expect(petInputsFromTui({ ...running, streamingToolCards: [pendingCard] }).activity).toBe("working");
    expect(petInputsFromTui({ ...running, streamingToolCards: [{ ...pendingCard, status: "ok" as const }] }).activity).toBe("thinking");
  });

  it("waits while an approval request is on screen", () => {
    const waiting = { ...base(), status: "awaiting_approval" as const, pendingApproval: { approvalId: "a1" } as never };
    expect(petInputsFromTui(waiting).waiting).toBe(true);
  });

  it("reads how the newest run ended, once", () => {
    expect(petEndingOf(run("completed", 1))).toBe("done");
    expect(petEndingOf(run("failed", 1))).toBe("error");
    expect(petEndingOf(run("cancelled", 1))).toBe("stopped");
    const history = [run("completed", 5)];
    expect(petNewEnding(history, null)).toEqual({ ending: "done", finishedAt: 5 });
    expect(petNewEnding(history, 5)).toBeNull();
    expect(petNewEnding([], null)).toBeNull();
  });
});

describe("terminal pet driver (ATO-2513)", () => {
  it("does not flash a run that ended before the pet came up", () => {
    const driver = new PetTuiDriver(0);
    const start = { ...base(), runHistory: [run("failed", 50)] };
    expect(driver.update(start, 100).state).toBe("idle");
    expect(driver.update(start, 200).state).toBe("idle");
  });

  it("flashes done when a turn finishes, then goes back to idle", () => {
    const driver = new PetTuiDriver(0);
    driver.update(base(), 0);
    expect(driver.update({ ...base(), status: "running" }, 10).state).toBe("thinking");
    const after = { ...base(), runHistory: [run("completed", 1000)] };
    const flash = driver.update(after, 1000);
    expect(flash.state).toBe("done");
    expect(flash.nextAt).toBe(4000);
    expect(driver.update(after, 4000).state).toBe("idle");
  });

  it("shows error for a failed turn and nothing for a stopped one", () => {
    const failed = new PetTuiDriver(0);
    failed.update(base(), 0);
    expect(failed.update({ ...base(), runHistory: [run("failed", 900)] }, 900).state).toBe("error");
    const stopped = new PetTuiDriver(0);
    stopped.update(base(), 0);
    expect(stopped.update({ ...base(), runHistory: [run("cancelled", 900)] }, 900).state).toBe("idle");
  });
});
