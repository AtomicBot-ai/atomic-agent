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
