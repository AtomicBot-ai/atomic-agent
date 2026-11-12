// ATO-1370 / ATO-1372: a catalogue vision model on disk without its vision
// projector gets a Get vision files action in Settings' row and a chip in the
// composer's picker. Both are the usual pull (main fetches the projector
// alone, ATO-1369) with a disk check of the projector's own size.
//
// renderer.js is read as text; its decisions run in a vm context with what
// they call stood in for. No deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const acts = readFileSync(new URL("../renderer/analytics-acts.js", import.meta.url), "utf8");
function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}

const GIB = 1024 ** 3;
function ctx(extra) {
  const c = vm.createContext({
    DISK_GIB: GIB, BR: {}, toasts: [], pulls: [], room: Infinity,
    ...extra,
  });
  vm.runInContext(`
    function toast(title, text, tone) { toasts.push({ title, text, tone }); }
    function diskSpaceNow() { return null; }
    function diskFit(need) { return need <= room ? { ok: true } : { ok: false, text: 'needs ' + need }; }
    function llmPull(kind, id) { pulls.push({ kind, id }); }
  `, c);
  for (const name of ["obGbWord", "visionFetchable", "visionFetchLabel", "projectorDiskFit", "llmVisionFetch"]) vm.runInContext(fn(name), c);
  return c;
}

const missing = { id: "gemma-4-e4b", downloaded: true, vision: true, projectorMissing: true, mmprojSizeGb: 0.9 };

test("only a downloaded model missing its projector can fetch it", () => {
  const c = ctx();
  assert.equal(c.visionFetchable(missing), true);
  assert.equal(c.visionFetchable({ ...missing, projectorMissing: undefined }), false, "the projector is there");
  assert.equal(c.visionFetchable({ ...missing, downloaded: false }), false, "Download brings both");
  assert.equal(c.visionFetchable({ id: "qwen-3.5-2b", downloaded: true, vision: false }), false, "a text model has none");
  assert.equal(c.visionFetchable(undefined), false);
});

test("the action names the projector's size", () => {
  const c = ctx();
  assert.equal(c.visionFetchLabel(missing), "Get vision files · 0.9 GB");
  assert.equal(c.visionFetchLabel({ ...missing, mmprojSizeGb: undefined }), "Get vision files");
});

test("Settings' action is the usual chat pull, refused when the projector does not fit", () => {
  const c = ctx();
  assert.equal(c.llmVisionFetch(missing), true);
  assert.deepEqual(JSON.parse(JSON.stringify(c.pulls)), [{ kind: "chat", id: "gemma-4-e4b" }]);
  const tight = ctx({ room: 0.5 * GIB });
  assert.equal(tight.llmVisionFetch(missing), false);
  assert.equal(tight.pulls.length, 0);
  assert.equal(tight.toasts[0].title, "Not enough disk space");
  assert.equal(ctx().llmVisionFetch({ ...missing, projectorMissing: false }), false);
});

test("the rows carry the action, apart from the row's own click", () => {
  assert.ok(source.includes("rowAct('llm:visionAt:' + index, visionFetchLabel(m))"), "Settings' second verb on the row");
  assert.ok(source.includes("if (verb === 'visionAt')"));
  assert.ok(source.includes("data-act=\"sel:vision:' + esc(r.id) + '\""), "the picker's chip has its own act");
  assert.ok(source.includes("if (a.startsWith('sel:vision:'))"));
  assert.ok(source.includes("vision ? modelVisionFact(m) : ''"), "the picker says text only");
  assert.ok(source.includes("visionFetchable(model) ? projectorDiskFit(model) : modelDiskFit(model)"), "selPull checks the projector's room");
  assert.match(acts, /cancelPull:L, vision:L\}/);
  assert.match(acts, /visionAt:L/);
});
