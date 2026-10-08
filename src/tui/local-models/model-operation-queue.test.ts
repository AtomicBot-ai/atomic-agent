import { describe, expect, it } from "vitest";
import { ModelOperationQueue } from "./model-operation-queue.js";
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => {resolve=r;}); return {promise,resolve}; }
describe("model operation ownership", () => {
  it("cancels an owned load, skips intermediate choices and waits for cleanup", async () => {
    const q = new ModelOperationQueue(), loading = deferred(), cleaned = deferred();
    const calls: string[] = [];
    const a = q.run(async signal => {
      calls.push("A"); loading.resolve();
      await new Promise<void>(r => signal.addEventListener("abort", () => r(), {once:true}));
      await cleaned.promise; calls.push("cleaned A"); return true;
    }, false);
    await loading.promise;
    const b = q.run(async () => {calls.push("B");return true;}, false);
    const c = q.run(async () => {calls.push("C");return true;}, false);
    expect(q.busy).toBe(true); expect(calls).toEqual(["A"]);
    cleaned.resolve(); expect(await a).toBe(false); expect(await b).toBe(false); expect(await c).toBe(true);
    expect(calls).toEqual(["A","cleaned A","C"]); expect(q.busy).toBe(false);
  });
  it("an explicit stop prevents an older restart from starting again", async () => {
    const q=new ModelOperationQueue(), stopping=deferred(), release=deferred(); const calls:string[]=[];
    const restart=q.run(async () => {
      await q.run(async()=>{calls.push("stop A");stopping.resolve();await release.promise;},undefined);
      return q.run(async()=>{calls.push("start A");return true;},false);
    },false);
    await stopping.promise;
    const stop=q.run(async()=>{calls.push("stop final");},undefined);
    release.resolve(); await Promise.all([restart,stop]); expect(calls).toEqual(["stop A","stop final"]);
  });
  it("a new selection waits for an older stop to finish touching the pid file", async () => {
    const q=new ModelOperationQueue(), stopping=deferred(), release=deferred();const calls:string[]=[];
    const stop=q.run(async()=>{stopping.resolve();await release.promise;calls.push("stopped");},undefined);
    await stopping.promise;
    const start=q.run(async()=>{calls.push("started");return true;},false);
    expect(calls).toEqual([]);release.resolve();await Promise.all([stop,start]);expect(calls).toEqual(["stopped","started"]);
  });
  it("shutdown cancels pending launches and waits for owned work", async () => {
    const q=new ModelOperationQueue(), entered=deferred();let cancelled=false;
    const a=q.run(async signal=>{entered.resolve();await new Promise<void>(r=>signal.addEventListener("abort",()=>r(),{once:true}));cancelled=true;return true;},false);
    await entered.promise;await q.close();expect(cancelled).toBe(true);expect(await a).toBe(false);
    expect(await q.run(async()=>{throw Error("spawn after quit");},false)).toBe(false);
  });
  it("serializes background maintenance without blocking Send, and cancels it for a choice", async () => {
    const q = new ModelOperationQueue(), entered = deferred(), released = deferred();
    const calls: string[] = [];
    await q.run(async () => {
      q.defer(async signal => {
        calls.push("maintenance"); entered.resolve();
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        await released.promise; calls.push("cleaned"); return true;
      });
      return true;
    }, false);
    await entered.promise;
    expect(q.busy).toBe(true);
    expect(q.switching).toBe(false);
    const choice = q.run(async () => { calls.push("choice"); return true; }, false);
    expect(q.switching).toBe(true);
    released.resolve(); await choice;
    expect(calls).toEqual(["maintenance", "cleaned", "choice"]);
    expect(q.switching).toBe(false);
  });

  it("does not run deferred maintenance ahead of a newer user request", async () => {
    const q = new ModelOperationQueue(), entered = deferred(), released = deferred();
    let maintained = false;
    const start = q.run(async () => {
      q.defer(async () => { maintained = true; return true; });
      entered.resolve(); await released.promise; return true;
    }, false);
    await entered.promise;
    const choice = q.run(async () => true, false);
    released.resolve(); await Promise.all([start, choice]);
    expect(maintained).toBe(false);
  });

  it("queues work inherited from a completed async scope instead of bypassing ownership", async () => {
    const q = new ModelOperationQueue(), trigger = deferred(), entered = deferred(), release = deferred();
    let late!: Promise<boolean>;
    let ran = false;
    await q.run(async () => {
      late = trigger.promise.then(() => q.run(async () => { ran = true; return true; }, false, false));
      return true;
    }, false);
    const active = q.run(async () => { entered.resolve(); await release.promise; return true; }, false);
    await entered.promise; trigger.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(ran).toBe(false);
    release.resolve(); await Promise.all([active, late]); expect(ran).toBe(true);
  });

});
