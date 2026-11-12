// ATO-1331: a catalogue vision model's projector, against the built output
// (npm run build first). Main adds `--mmproj` to every catalogue pull and
// keeps it on one bar; renderer.js is read as text and its decisions run in a
// vm context, with what they call stood in for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const P = require("../out/main/pull-projector.js");
const { CURATED_MODEL_META } = require("../out/main/model-catalog.js");

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
function fn(name) {
  const sync = source.indexOf("\nfunction " + name + "(");
  const at = sync >= 0 ? sync : source.indexOf("\nasync function " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}

test("a catalogue vision model pulls its projector; a text model and a Hugging Face one do not", () => {
  assert.equal(P.catalogPullWantsProjector("gemma-4-e4b"), true);
  assert.equal(P.catalogPullWantsProjector("qwen-3.5-4b"), true);
  assert.equal(P.catalogPullWantsProjector("qwen-3.5-2b"), false, "the starter is text-only");
  assert.equal(P.catalogPullWantsProjector("custom-some-repo-gguf"), false, "cli:hfProjector owns those");
});

test("every vendored vision row has the projector size the bar is built on", () => {
  for (const m of CURATED_MODEL_META) assert.equal(m.mmprojSizeGb > 0, m.vision, m.id);
});

test("every pull starts through startModelPull, which decides the flag", () => {
  assert.equal(main.match(/\bmodelsPull\(id, \(line\)/g).length, 1);
  assert.ok(main.includes("const withProjector = mmproj || catalogPullWantsProjector(id);"));
  assert.ok(main.includes("}, withProjector);"));
});

const GIB = 1024 ** 3;
const weightsLine = (percent, gb) => ({ kind: "weights", percent, transferredBytes: gb * GIB, totalBytes: 4 * GIB });

test("weights then projector fill one bar, and it never falls back", () => {
  const meta = CURATED_MODEL_META.find((m) => m.id === "qwen-3.5-4b");
  const total = (meta.sizeGb + meta.mmprojSizeGb) * GIB;
  const whole = P.wholePullProgress("qwen-3.5-4b");
  const seen = [
    whole("[=] 50%", { kind: "weights", percent: 50, transferredBytes: (meta.sizeGb / 2) * GIB, totalBytes: meta.sizeGb * GIB }),
    whole("[=] 100%", { kind: "weights", percent: 100, transferredBytes: meta.sizeGb * GIB, totalBytes: meta.sizeGb * GIB }),
  ];
  assert.deepEqual(whole("downloading mmproj mmproj-F16.gguf", {}), {});
  seen.push(
    whole("[=] 0%", { kind: "weights", percent: 0, transferredBytes: 0, totalBytes: meta.mmprojSizeGb * GIB }),
    whole("[=] 100%", { kind: "weights", percent: 100, transferredBytes: meta.mmprojSizeGb * GIB, totalBytes: meta.mmprojSizeGb * GIB }),
  );
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].percent >= seen[i - 1].percent, JSON.stringify(seen));
    assert.ok(seen[i].transferredBytes >= seen[i - 1].transferredBytes, JSON.stringify(seen));
  }
  assert.equal(seen[seen.length - 1].percent, 100);
  assert.ok(seen.every((f) => f.totalBytes === Math.round(total)));
  assert.equal(seen[0].kind, "weights", "the download card's bar, not a second row");
});

test("a frame with only a percent gets no invented bytes, and a text model's frames pass through", () => {
  const whole = P.wholePullProgress("qwen-3.5-4b");
  const loose = whole("weights 50%", { kind: "weights", percent: 50 });
  assert.equal(loose.transferredBytes, undefined);
  assert.ok(loose.percent < 50);
  const frame = weightsLine(50, 2);
  assert.equal(P.wholePullProgress("qwen-3.5-2b")("x", frame), frame);
});

test("only a finished projector counts as on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "ato-1331-"));
  try {
    assert.equal(P.projectorOnDisk(join(dir, "absent")), false);
    const model = join(dir, "m");
    mkdirSync(model);
    writeFileSync(join(model, "weights.gguf"), "");
    writeFileSync(join(model, "mmproj-F16.gguf.part"), "");
    assert.equal(P.projectorOnDisk(model), false);
    writeFileSync(join(model, "mmproj-F16.gguf"), "");
    assert.equal(P.projectorOnDisk(model), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function renderer(names, extra) {
  const c = vm.createContext({
    DL: { ready: null, failed: [] },
    LLMP: { msg: null },
    toasts: [],
    fails: [],
    refreshed: 0,
    snapshots: 0,
    ...extra,
  });
  vm.runInContext(`
    function toast(title, text, tone) { toasts.push({ title, text, tone }); }
    function bswSnapshot() { snapshots++; }
    function llmRefresh() { refreshed++; }
    function llmRepaint() {}
    function dlFail(job, error, retry) { fails.push({ job, error, retry }); }
    function xpullRetry(owner) { return 'retry:' + owner.id; }
    function render() {}
    async function llmRefreshStatus() {}
    function visionLanded() { return false; }
    function visionFetchable() { return false; }
    function projectorDiskFit() { return { ok: true }; }
  `, c);
  for (const name of ["projectorSkippedText", ...names]) vm.runInContext(fn(name), c);
  return c;
}

test("the composer's pull that lost the projector offers no Switch and says text only", async () => {
  const c = renderer(["selPullFinished"]);
  await c.selPullFinished("gemma-4-e4b", { ok: true, projectorSkipped: true });
  assert.equal(c.DL.ready, null);
  assert.equal(c.snapshots, 1, "the weights are on disk: the chip and the picker read the list again");
  assert.equal(c.toasts[0].tone, "bad");
  assert.match(c.toasts[0].text, /text only/);
  await c.selPullFinished("gemma-4-e4b", { ok: true });
  assert.equal(c.DL.ready.id, "gemma-4-e4b", "a whole download still offers it");
  c.DL.ready = null;
  await c.selPullFinished("gemma-4-e4b", { ok: false, error: "killed" });
  assert.equal(c.DL.ready, null);
});

test("Settings' pull that lost the projector starts nothing and says so", () => {
  const c = renderer(["llmProjectorSkipped"]);
  c.llmProjectorSkipped();
  assert.match(c.LLMP.msg.text, /^! .*text only/);
  assert.equal(c.DL.ready, null);
  assert.equal(c.refreshed, 1, "the weights are on disk: the list is read again");
});

test("a lost projector is a failed row with Retry; a whole pull and a failed one add none here", () => {
  const c = renderer(["xpullProjectorSkipped"]);
  const owner = { kind: "weights", id: "gemma-4-e4b" };
  assert.equal(c.xpullProjectorSkipped(owner, { ok: true }), false);
  assert.equal(c.xpullProjectorSkipped(owner, { ok: false, projectorSkipped: true }), false);
  assert.equal(c.fails.length, 0);
  assert.equal(c.xpullProjectorSkipped(owner, { ok: true, projectorSkipped: true }), true);
  assert.equal(c.fails[0].job.kind, "projector");
  assert.equal(c.fails[0].retry, "retry:gemma-4-e4b");
});

test("a model on disk without its projector does not promise images", () => {
  const c = renderer(["modelVisionFact", "modelFactsLine"]);
  const row = { size: "4 GB", context: "128K", vision: true, downloaded: true };
  assert.match(c.modelFactsLine(row), /reads images/);
  assert.doesNotMatch(c.modelFactsLine({ ...row, projectorMissing: true }), /reads images/);
  assert.match(c.modelFactsLine({ ...row, projectorMissing: true }), /text only/);
});

test("a Retry the disk check refuses says so, so dlRetry keeps its row", () => {
  const c = renderer(["selPull"], { SEL: { local: [{ id: "m" }] }, BR: {} });
  vm.runInContext(`
    function xpullOwner() { return null; }
    function dlChipBusy() { return false; }
    function modelDiskFit() { return { ok: false, text: "no room" }; }
  `, c);
  assert.equal(c.selPull("m"), false);
  assert.equal(c.SEL.pulling, undefined, "nothing started");
});

const sevenGib = 7 * GIB;
test("Settings' banner follows the whole pull, and keeps the agent's line for anything else", () => {
  const c = vm.createContext({});
  vm.runInContext(fn("llmPullView"), c);
  const line = "[====                ] 20%  0.20 GB / 1.00 GB  mmproj-F16.gguf";
  const frame = { kind: "weights", percent: 90, transferredBytes: 6 * GIB, totalBytes: sevenGib };
  const whole = c.llmPullView(line, frame);
  assert.equal(whole.pct, 90);
  assert.equal(whole.meta, "6.0 GB of 7.0 GB · 90%");
  assert.equal(whole.file, "mmproj-F16.gguf");
  assert.equal(c.llmPullView("downloading mmproj mmproj-F16.gguf", frame).pct, 90, "a line with no percent does not empty the bar");
  assert.equal(c.llmPullView(line).pct, 20);
  const hf = c.llmPullView("Model (mmproj) 40% (12.0 / 30.0 MB)", { kind: "projector", percent: 40, transferredBytes: 12e6, totalBytes: 30e6 });
  assert.match(hf.meta, /\(mmproj\)/, "a Hugging Face projector keeps its own label");
});

test("the model holding the pull slot is not called missing a projector; the others still are", () => {
  const list = { ok: true, models: [{ id: "a", projectorMissing: true }, { id: "b", projectorMissing: true }, { id: "c" }] };
  const during = P.withoutLivePullGap(list, "a");
  assert.equal("projectorMissing" in during.models[0], false);
  assert.equal(during.models[1].projectorMissing, true);
  assert.equal(P.withoutLivePullGap(list, null), list);
  const failed = { ok: false, error: "x" };
  assert.equal(P.withoutLivePullGap(failed, "a"), failed);
});

test("analytics keep the skipped projector", () => {
  const catalog = readFileSync(new URL("../main/analytics/catalog.ts", import.meta.url), "utf8");
  assert.ok(catalog.includes("projector_skipped: bool"), "the catalogue drops a property it does not list");
  assert.ok(main.includes("A.downloadFinished(id, res, projectorSkipped);"));
  assert.ok(main.indexOf("const progress = whole ? whole(line, parsed) : parsed;") < main.indexOf("A.downloadProgress(id, progress);"));
});
