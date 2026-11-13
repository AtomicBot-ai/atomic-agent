import { beforeEach, describe, expect, it, vi } from "vitest";

const check = vi.hoisted(() => ({ impl: vi.fn() }));
vi.mock("../../update/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../update/index.js")>()),
  checkForAppUpdate: (...args: unknown[]) => check.impl(...args),
  canSelfUpdate: () => true,
  detectInstallSource: () => null,
}));

import { ChatOrchestrator } from "../chat-orchestrator.js";
import { REQUIRED_UPDATE_REFUSAL } from "./required-update.js";

const PAST_GATE = "past the required-update gate";

type Gate = {
  requiredUpdate: string | null;
  session: { id: string; turns: unknown[] } | null;
  currentController: AbortController | null;
  queue: string[];
  runOneTurn(text: string, fromQueue?: boolean): Promise<void>;
  checkForUpdate(): Promise<void>;
};

function fixture(opts: { required: "broken" | "below-minimum" | null; turns?: number }) {
  const emit = vi.fn();
  const app = Object.assign(Object.create(ChatOrchestrator.prototype), {
    currentController: null,
    detachedTurns: { size: 0 },
    queue: [],
    composerRoutePending: false,
    quitting: false,
    requiredUpdate: opts.required,
    session: { id: "s1", turns: Array.from({ length: opts.turns ?? 0 }, () => ({})) },
    runtime: {
      config: { update: { checkOnStartup: true, repo: "o/r" } },
      turnController: { busySessionIds: () => [] },
    },
    bus: { emit },
    cancelPromptEnhance: () => {},
    ensureSession(this: Gate) { return this.session; },
    emitQueue: () => {},
    // The first step after the gate: reaching it means the turn starts.
    announceHeapPressure: () => { throw new Error(PAST_GATE); },
  }) as unknown as Gate & Pick<ChatOrchestrator, "sendMessage">;
  return { app, emit };
}

describe("required-update gate in the orchestrator (ATO-1125)", () => {
  beforeEach(() => check.impl.mockReset());

  it("broken: a new chat is refused with the update command and the text goes back", async () => {
    const f = fixture({ required: "broken" });
    await f.app.runOneTurn("hello");
    expect(f.emit).toHaveBeenCalledWith({ type: "turn_gate_blocked", text: REQUIRED_UPDATE_REFUSAL });
    expect(REQUIRED_UPDATE_REFUSAL).toContain("atomic-agent update");
    expect(f.emit).toHaveBeenCalledWith({ type: "input_changed", value: "hello" });
  });

  it("below minimum: the chat starts", async () => {
    const f = fixture({ required: "below-minimum" });
    await expect(f.app.runOneTurn("hello")).rejects.toThrow(PAST_GATE);
    expect(f.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "turn_gate_blocked" }));
  });

  it("broken: a session that already has turns keeps going", async () => {
    const f = fixture({ required: "broken", turns: 2 });
    await expect(f.app.runOneTurn("next")).rejects.toThrow(PAST_GATE);
  });

  it("broken: a message queued behind a running turn is never dropped", async () => {
    const f = fixture({ required: "broken" });
    f.app.currentController = new AbortController();
    f.app.sendMessage("while running");
    expect(f.app.queue).toEqual(["while running"]);
    await expect(f.app.runOneTurn("while running", true)).rejects.toThrow(PAST_GATE);
    expect(f.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "turn_gate_blocked" }));
  });

  it("carries the policy reason from the check into the offer", async () => {
    check.impl.mockResolvedValue({
      updateAvailable: true, currentVersion: "0.6.10", latestTag: "v0.7.1", latestVersion: "0.7.1",
      updateRequired: true, requiredReason: "broken",
    });
    const f = fixture({ required: null });
    await f.app.checkForUpdate();
    expect(f.emit).toHaveBeenCalledWith({
      type: "update_available", current: "0.6.10", latest: "0.7.1", required: "broken",
    });
    expect(f.app.requiredUpdate).toBe("broken");
  });

  it("a failed policy fetch blocks nothing", async () => {
    check.impl.mockRejectedValue(new Error("offline"));
    const f = fixture({ required: null });
    await f.app.checkForUpdate();
    expect(f.emit).not.toHaveBeenCalled();
    expect(f.app.requiredUpdate).toBeNull();
    await expect(f.app.runOneTurn("hello")).rejects.toThrow(PAST_GATE);
  });
});
