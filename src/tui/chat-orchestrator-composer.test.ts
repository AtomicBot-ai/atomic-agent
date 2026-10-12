import { expect, it, vi } from "vitest";
import { ChatOrchestrator } from "./chat-orchestrator.js";

function fixture(change: () => Promise<boolean>, stillWanted = () => true) {
  const emit = vi.fn();
  const setMode = vi.fn(async () => {});
  const app = Object.assign(Object.create(ChatOrchestrator.prototype), {
    currentController: null, detachedTurns: { size: 0 }, queue: [], composerRoutePending: false,
    runtime: { turnController: { busySessionIds: () => [] } }, bus: { emit },
    localModels: { chooseEngine: vi.fn(change), captureStopGuard: () => stillWanted },
    runMode: { current: () => ({ effective: "fusion", orchestratorProviderId: "cloud", workerProviderId: "local-llama" }), setMode },
  }) as ChatOrchestrator;
  return { app, emit, setMode };
}
it("keeps typed messages in the composer while the engine change is unresolved", async () => {
  let finish!: (ok: boolean) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const changing = f.app.chooseComposerEngine("atomic-core", "worker");
  f.app.sendMessage("keep this message");
  f.app.steerMessage("and this draft");
  expect(f.emit).toHaveBeenCalledWith({type: "input_changed", value: "keep this message"});
  expect(f.emit).toHaveBeenCalledWith({type: "input_changed", value: "and this draft"});
  expect(f.setMode).not.toHaveBeenCalled();
  finish(true); await changing;
  expect(f.setMode).toHaveBeenCalledWith("fusion", {stillWanted: expect.any(Function), fusion: {orchestratorProvider: "cloud", workerProvider: "local-llama"}});
  expect(f.emit).toHaveBeenCalledWith({type: "composer_switch_opened", kind: "workers"});
});
it("a refused engine change never changes the Fusion role", async () => {
  const f = fixture(async () => false);
  await f.app.chooseComposerEngine("llama-server", "worker");
  expect(f.setMode).not.toHaveBeenCalled();
});
it("never assigns the one local runtime to both roles", async () => {
  const change = vi.fn(async () => true); const f = fixture(change);
  await f.app.chooseComposerEngine("atomic-core", "orchestrator");
  expect(change).not.toHaveBeenCalled(); expect(f.setMode).not.toHaveBeenCalled();
});

it("Stop during an engine change prevents late Fusion activation", async () => {
  let wanted = true; let finish!: (ok: boolean) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }), () => wanted);
  const pending = f.app.chooseComposerEngine("atomic-core", "worker");
  wanted = false; finish(true); await pending;
  expect(f.setMode).not.toHaveBeenCalled();
  expect(f.emit).not.toHaveBeenCalledWith({type: "composer_switch_opened", kind: "workers"});
});

it("a queued message drained during a route change stays queued and resumes afterwards", async () => {
  let finish!: (ok: boolean) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const resume = vi.fn(async () => {});
  const state = f.app as unknown as { queue: string[]; resumeModelQueue: () => Promise<void>; runOneTurn(text: string, fromQueue: boolean): Promise<void> };
  state.queue.push("second");
  state.resumeModelQueue = resume;
  const changing = f.app.chooseComposerEngine("atomic-core", "worker");
  await state.runOneTurn("first", true);
  expect(state.queue).toEqual(["first", "second"]);
  expect(f.emit).toHaveBeenCalledWith({ type: "queue_changed", queued: ["first", "second"] });
  expect(f.emit).not.toHaveBeenCalledWith({ type: "input_changed", value: "first" });
  expect(resume).not.toHaveBeenCalled();
  finish(true); await changing;
  expect(resume).toHaveBeenCalledTimes(1);
});

it("a model start resuming the queue mid route change leaves the backlog for the change's end", async () => {
  let finish!: (ok: boolean) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const app = f.app as unknown as {
    queue: string[]; quitting: boolean; session: { id: string };
    localModels: { waitForSwitch: (signal: AbortSignal) => Promise<void> };
    resumeModelQueue(): Promise<void>; runOneTurn(text: string, fromQueue?: boolean): Promise<void>;
  };
  Object.assign(app, { quitting: false, session: { id: "s1" } });
  app.localModels.waitForSwitch = async () => {};
  app.queue.push("first", "second");
  const original = app.runOneTurn.bind(app);
  const ran: string[] = [];
  // Only a turn that gets past the route-change guard is recorded instead of run.
  vi.spyOn(app, "runOneTurn").mockImplementation(async (text, fromQueue) => {
    if ((app as unknown as { composerRoutePending: boolean }).composerRoutePending) return original(text, fromQueue);
    ran.push(text);
  });
  const changing = f.app.chooseComposerEngine("atomic-core", "worker");
  // What onManagedDaemonRestarted does when the change starts a model.
  await app.resumeModelQueue();
  expect(app.queue).toEqual(["first", "second"]);
  expect(ran).toEqual([]);
  expect(f.emit).not.toHaveBeenCalledWith({ type: "input_changed", value: "first" });
  finish(true); await changing;
  await vi.waitFor(() => expect(ran).toEqual(["first"]));
  expect(app.queue).toEqual(["second"]);
});
