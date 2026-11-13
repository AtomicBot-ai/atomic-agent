// "If some model was downloaded before, it should just get picked up."
// The setup's Local step leads with the models already on this computer
// (BR.discoverLocalModels); Use registers one in place and hands its id to
// the same hand-over a .gguf pick uses (obDownloadAndHandOver).
//
// renderer.js is read as text; the obFound* functions run in a vm context. No deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");

function slice(startMarker, endFn) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker.trim()} is in renderer.js`);
  const fnAt = source.indexOf(`\nasync function ${endFn}(`, start);
  assert.ok(fnAt >= 0, `${endFn} follows it`);
  return source.slice(start + 1, source.indexOf("\n}\n", fnAt) + 2);
}

// Values built inside the vm context carry its Array/Object prototypes, which
// deepStrictEqual tells apart from this realm's: compare them as plain data.
const plain = (x) => JSON.parse(JSON.stringify(x));

const FOUND = [
  { path: "/m/lms/Qwen3-4B-Q8_0.gguf", name: "Qwen3-4B-Q8_0", sizeBytes: 4.3 * 1024 ** 3, source: "lmstudio", quant: "Q8_0", registered: false },
  { path: "/m/store/qwen3-8b/Qwen3-8B.gguf", name: "Qwen 3 8B", sizeBytes: 5 * 1024 ** 3, source: "atomic", registered: true },
  { path: "/m/hf/phi-4.gguf", name: "phi-4", sizeBytes: 9 * 1024 ** 3, source: "huggingface", registered: false },
];

function run({ answer, downloading = false, models = FOUND } = {}) {
  const calls = { use: [], handedOver: [], dispatched: [], discovered: [] };
  const decl = source.match(/\nconst OB_FOUND = [^\n]+\n/);
  assert.ok(decl, "OB_FOUND is declared");
  const words = source.match(/\nconst FOUND_SOURCE_WORDS = \{[\s\S]*?\n\};\n/);
  assert.ok(words, "FOUND_SOURCE_WORDS is declared");
  const c = vm.createContext({
    OB: { open: true, step: "local_pick", pendingMmproj: { stale: true } },
    BR: {
      useLocalModel: async (p, o) => { calls.use.push([p, o]); return answer; },
      discoverLocalModels: async (o) => { calls.discovered.push(o); return { models }; },
    },
    DL: { projector: null }, SEL: { pulling: false }, LLMP: { pulling: false },
    IS_MAC: true,
    dlBusy: () => downloading,
    render: () => {},
    esc: (s) => String(s),
    ic: () => "",
    obGbWord: (gb) => `${Math.round(gb * 10) / 10} GB`,
    obDispatch: (a) => calls.dispatched.push(a),
    obDownloadAndHandOver: (id) => calls.handedOver.push(id),
  });
  vm.runInContext(decl[0].replace("const ", "var ") + words[0].replace("const ", "var ")
    + slice("\nfunction obFoundLoad(", "obFoundUse")
    + "\nthis.use = obFoundUse; this.html = obFoundHTML; this.load = obFoundLoad;", c);
  c.OB_FOUND.models = models;
  return { c, calls };
}

test("the found models lead the step, without the ones the app already knows", () => {
  const { c } = run();
  const html = c.html();
  assert.match(html, /You already have models on this Mac/);
  assert.match(html, /Qwen3-4B-Q8_0/);
  assert.match(html, /4\.3 GB · Q8_0 · from LM Studio/);
  assert.match(html, /from Hugging Face/);
  assert.doesNotMatch(html, /Qwen 3 8B/, "a registered model is in the download list already, on disk");
  assert.match(html, /Use this/);
  assert.match(html, /Or download a model/);
  assert.ok(html.indexOf("local:found:0") >= 0 && html.indexOf("local:found:1") >= 0);
});

test("nothing found: nothing drawn, the download list is the step", () => {
  const { c } = run({ models: [] });
  assert.equal(c.html(), "");
  c.OB_FOUND.models = null;
  assert.equal(c.html(), "");
});

test("Use registers in place and hands the id to the setup's own pull", async () => {
  const { c, calls } = run({ answer: { ok: true, id: "custom-local-phi-4-1a2b3c4d" } });
  await c.use(1);   // the second unregistered row
  assert.deepEqual(plain(calls.use), [["/m/hf/phi-4.gguf", { registerOnly: true }]]);
  assert.deepEqual(calls.handedOver, ["custom-local-phi-4-1a2b3c4d"]);
  assert.equal(c.OB.pendingMmproj, null);
  assert.equal(c.OB_FOUND.models, null, "asked again on the next visit");
});

test("a refusal shows the reason and looks again", async () => {
  const { c, calls } = run({ answer: { ok: false, error: "No such file: /m/lms/Qwen3-4B-Q8_0.gguf" } });
  await c.use(0);
  assert.deepEqual(calls.handedOver, []);
  assert.equal(calls.dispatched[0].type, "onboarding_error_set");
  assert.equal(calls.dispatched[0].error, "No such file: /m/lms/Qwen3-4B-Q8_0.gguf");
  assert.deepEqual(plain(calls.discovered), [{ fresh: true }]);
});

test("a download already running is said, not raced; a second click waits for the first", async () => {
  const busy = run({ answer: { ok: true, id: "x" }, downloading: true });
  await busy.c.use(0);
  assert.equal(busy.calls.use.length, 0);
  assert.equal(busy.calls.dispatched[0].error, "a download is already running");

  const { c, calls } = run({ answer: null });
  let release;
  c.BR.useLocalModel = (p) => { calls.use.push(p); return new Promise((r) => { release = r; }); };
  const first = c.use(0);
  await c.use(1);
  assert.equal(calls.use.length, 1);
  release({ ok: true, id: "custom-local-q-1" });
  await first;
  assert.deepEqual(calls.handedOver, ["custom-local-q-1"]);
});

test("the setup left the step meanwhile: nothing is handed over", async () => {
  const { c, calls } = run({ answer: { ok: true, id: "x" } });
  c.BR.useLocalModel = async () => { c.OB.step = "choose"; return { ok: true, id: "x" }; };
  await c.use(0);
  assert.deepEqual(calls.handedOver, []);
});
