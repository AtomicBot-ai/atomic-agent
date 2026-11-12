// ATO-1402: "Use a .gguf file I already have" on the Local models screen.
// The card is drawn while the model list is still loading (OB.busy), so it
// must open the file dialog then too, and hand the registered file to the
// same hand-over a curated pick uses.
//
// renderer.js is read as text; obGgufPick runs in a vm context. No deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");

function picker() {
  const start = source.indexOf("\nlet OB_GGUF_PICKING = false;");
  assert.ok(start >= 0, "OB_GGUF_PICKING is declared in renderer.js");
  const fnAt = source.indexOf("\nasync function obGgufPick(", start);
  assert.ok(fnAt >= 0, "obGgufPick follows it");
  return source.slice(start + 1, source.indexOf("\n}\n", fnAt) + 2);
}

function run({ busy, answer, downloading = false }) {
  const calls = { dialog: 0, handedOver: [], dispatched: [] };
  const c = vm.createContext({
    OB: { open: true, step: "local_pick", busy, pendingMmproj: { stale: true } },
    BR: { ggufPick: async () => { calls.dialog += 1; return answer; } },
    DL: { projector: null },
    SEL: { pulling: false },
    LLMP: { pulling: false },
    dlBusy: () => downloading,
    obDispatch: (a) => calls.dispatched.push(a),
    obDownloadAndHandOver: (id) => calls.handedOver.push(id),
  });
  vm.runInContext(picker() + "\nthis.pick = obGgufPick;", c);
  return { c, calls };
}

test("the dialog opens while the model list is still loading", async () => {
  const { c, calls } = run({ busy: true, answer: { ok: true, id: "custom-local-qwen-1a2b3c4d" } });
  await c.pick();
  assert.equal(calls.dialog, 1);
  assert.deepEqual(calls.handedOver, ["custom-local-qwen-1a2b3c4d"]);
  assert.equal(c.OB.pendingMmproj, null);
});

test("a cancelled dialog changes nothing and says nothing", async () => {
  const { c, calls } = run({ busy: false, answer: { ok: false, cancelled: true, error: "cancelled" } });
  await c.pick();
  assert.equal(calls.dialog, 1);
  assert.deepEqual(calls.handedOver, []);
  assert.deepEqual(calls.dispatched, []);
});

test("a file the agent refuses shows the reason on the screen", async () => {
  const { c, calls } = run({ busy: false, answer: { ok: false, error: "Not a .gguf file: /x/model.bin" } });
  await c.pick();
  assert.deepEqual(calls.handedOver, []);
  assert.equal(calls.dispatched.length, 1);
  assert.equal(calls.dispatched[0].type, "onboarding_error_set");
  assert.equal(calls.dispatched[0].error, "Not a .gguf file: /x/model.bin");
});

test("a second click while the dialog is open does not open another", async () => {
  let release;
  const { c, calls } = run({ busy: false, answer: null });
  c.BR.ggufPick = () => { calls.dialog += 1; return new Promise((r) => { release = r; }); };
  const first = c.pick();
  await c.pick();
  assert.equal(calls.dialog, 1);
  release({ ok: false, cancelled: true });
  await first;
});

test("a download already running is said, not raced", async () => {
  const { c, calls } = run({ busy: false, answer: { ok: true, id: "x" }, downloading: true });
  await c.pick();
  assert.equal(calls.dialog, 0);
  assert.equal(calls.dispatched[0].error, "a download is already running");
});
