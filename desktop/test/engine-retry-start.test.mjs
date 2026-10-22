// ATO-821: when the launch's engine install fails, the launch start never
// runs. The next install that succeeds (the download card's Retry) must start
// the model as the launch would have, and every failed install is written to
// agent.log, not only to the terminal. main.ts is read as text: the launch
// start's functions are transpiled and run in a vm with their neighbours
// stubbed (main.ts itself needs Electron).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
function slice(start, end) {
  const i = main.indexOf(start);
  assert.ok(i >= 0, start);
  const j = main.indexOf(end, i);
  assert.ok(j > i, end);
  return main.slice(i, j);
}

function load({ installs = [false], downloaded = true, route = "local-llama" } = {}) {
  const calls = { bringUp: [], said: [], installs: 0, mark: 0 };
  const code = ts.transpileModule(
    slice("async function startLocalDaemonAtBoot(): Promise<void> {", "/**\n * U29: before")
      + "\nthis.boot = startLocalDaemonAtBoot; this.after = startAfterEngineInstall; this.pending = () => launchStartAfterInstall;",
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText;
  const ctx = vm.createContext({
    console: { error: () => {} },
    Date,
    readWholeConfig: async () => ({ ok: true, config: { localModels: { mode: "managed" }, llm: { activeTextProvider: route, providers: [{ id: "local-llama", kind: "llama-server" }, { id: "openrouter", kind: "openrouter" }] } } }),
    resolveRunMode: () => ({}),
    runModeWantsDaemon: () => false,
    modelsStatus: async () => ({ ok: true, status: { activeModel: "gemma", activeDownloaded: downloaded } }),
    managedEngineNow: () => "atomic-core",
    backendInstalled: () => false,
    installEngineAtLaunch: async () => { calls.installs++; return installs.shift() ?? true; },
    bringUpAtLaunch: async (id, via) => { calls.bringUp.push([id, via ?? "launch"]); return { daemon: "started" }; },
    sayDesktop: (line) => calls.said.push(line),
    stopsMark: () => calls.mark,
    A: { localBackendStarted() {}, launchBackendSettled() {} },
  });
  vm.runInContext(code, ctx);
  return { ctx, calls };
}

test("a launch whose engine install failed starts nothing, and remembers the start it owes", async () => {
  const { ctx, calls } = load({ installs: [false] });
  await ctx.boot();
  assert.equal(calls.installs, 1);
  assert.deepEqual(calls.bringUp, []);
  assert.equal(ctx.pending(), true);
});

test("the next successful install starts the model, once, as the start after an engine install", async () => {
  const { ctx, calls } = load({ installs: [false] });
  await ctx.boot();
  await ctx.after();
  assert.deepEqual(calls.bringUp, [["gemma", "update"]]);
  assert.equal(ctx.pending(), false);
  await ctx.after();
  assert.equal(calls.bringUp.length, 1, "a second install starts nothing more");
  assert.match(calls.said.join("\n"), /installed now; starting gemma/);
});

test("nothing is started after an install when no launch install had failed, or the route moved on", async () => {
  const fine = load({ installs: [true] });
  await fine.ctx.boot();
  assert.deepEqual(fine.calls.bringUp, [["gemma", "launch"]]);
  await fine.ctx.after();
  assert.equal(fine.calls.bringUp.length, 1);

  const moved = load({ installs: [false], route: "openrouter" });
  await moved.ctx.boot();
  assert.equal(moved.ctx.pending(), false, "a cloud route never owed a start");
  await moved.ctx.after();
  assert.deepEqual(moved.calls.bringUp, []);
});

test("a stop, switch or model change since the failed install drops the owed start", async () => {
  const { ctx, calls } = load({ installs: [false] });
  await ctx.boot();
  calls.mark++;   // Settings › Stop, a ⇄, a model change
  await ctx.after();
  assert.deepEqual(calls.bringUp, []);
  assert.equal(ctx.pending(), false);
});

test("the install stream says a failure in agent.log and owes the start only for a later install", () => {
  const stream = slice("function engineInstallStream(", "/** One `cli:pull` progress frame");
  assert.match(stream, /if \(!res\.ok && !own\.signal\.aborted\) sayDesktop\(`\[desktop\] local-llm: the local engine install did not finish/);
  assert.match(stream, /if \(res\.ok && !own\.signal\.aborted && via !== "launch"\) void startAfterEngineInstall\(\);/);
  const say = slice("function sayDesktop(line: string): void {", "\n}\n");
  assert.match(say, /appendAgentLog\(/);
  const bg = slice("onBackgroundBringUp((r) => {", "noteEngine(r, { via: r.via });");
  assert.match(bg, /sayDesktop\(line\)/, "the background start's outcome reaches agent.log too");
});
