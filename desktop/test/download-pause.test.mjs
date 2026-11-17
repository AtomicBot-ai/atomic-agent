// ATO-1503: Pause / Resume for a model download, against the built output
// (npm run build first). Main's half (main/download-pause.ts) and the card's
// (renderer/dl-pause.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../out/main/download-pause.js");
const { registerDownloadPauseIpc } = require("../out/main/download-pause-ipc.js");
const R = require("../renderer/dl-pause.js");

const tick = () => new Promise((r) => setImmediate(r));

/** A stand-in child: `exit(res)` ends it; `cancel` ends it as a SIGTERM does. */
function fakeRuns() {
  const runs = [];
  const start = (resumed) => {
    let exit;
    const done = new Promise((r) => { exit = r; });
    const run = { resumed, cancelled: false, exit, done, cancel: () => { run.cancelled = true; exit({ ok: false, error: "download exited with code null" }); } };
    runs.push(run);
    return run;
  };
  return { runs, start };
}

function hooks(extra = {}) {
  const h = { removed: 0, paused: [], removePartial: () => { h.removed += 1; }, cancelled: () => ({ ok: false, error: P.DOWNLOAD_CANCELLED }), onPause: (p) => h.paused.push(p), ...extra };
  return h;
}

test("pause stops the child and holds the slot; resume runs the same pull again; done comes once", async () => {
  const { runs, start } = fakeRuns();
  const h = hooks();
  const ctl = P.pausablePull(start, h);
  let ended = null;
  void ctl.done.then((r) => { ended = r; });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].resumed, false);
  assert.equal(ctl.pause(), true);
  assert.equal(runs[0].cancelled, true);
  assert.equal(ctl.state(), "pausing");
  await tick();
  assert.equal(ctl.state(), "paused");
  assert.deepEqual(h.paused, [true]);
  assert.equal(ended, null, "a pause is not the download's end");
  assert.equal(h.removed, 0, "a pause keeps the partial");
  assert.equal(ctl.pause(), false, "paused already");
  assert.equal(ctl.resume(), true);
  assert.equal(runs.length, 2);
  assert.equal(runs[1].resumed, true);
  assert.deepEqual(h.paused, [true, false]);
  runs[1].exit({ ok: true });
  await tick();
  assert.deepEqual(ended, { ok: true });
  assert.equal(ctl.state(), "ended");
  assert.equal(ctl.resume(), false);
});

test("Cancel on a running download stops it, then deletes the partial", async () => {
  const { runs, start } = fakeRuns();
  const h = hooks();
  const ctl = P.pausablePull(start, h);
  ctl.discard();
  assert.equal(runs[0].cancelled, true);
  const res = await ctl.done;
  assert.equal(res.error, P.DOWNLOAD_CANCELLED);
  assert.equal(h.removed, 1);
});

test("Cancel on a paused download deletes the partial at once", async () => {
  const { start } = fakeRuns();
  const h = hooks();
  const ctl = P.pausablePull(start, h);
  ctl.pause();
  await tick();
  ctl.discard();
  const res = await ctl.done;
  assert.equal(res.error, P.DOWNLOAD_CANCELLED);
  assert.equal(h.removed, 1);
  ctl.discard();
  assert.equal(h.removed, 1, "only once");
});

test("quitting stops it and keeps the partial, paused or not", async () => {
  for (const pauseFirst of [false, true]) {
    const { start } = fakeRuns();
    const h = hooks();
    const ctl = P.pausablePull(start, h);
    if (pauseFirst) { ctl.pause(); await tick(); }
    ctl.cancel();
    await ctl.done;
    assert.equal(h.removed, 0);
  }
});

test("a pull that finishes as Pause is pressed has finished", async () => {
  const { runs, start } = fakeRuns();
  const ctl = P.pausablePull(start, hooks());
  runs[0].cancel = () => {};   // too late: it already ended on its own
  ctl.pause();
  runs[0].exit({ ok: true });
  assert.deepEqual(await ctl.done, { ok: true });
});

test("a failure while running is the download's end, not a pause", async () => {
  const { runs, start } = fakeRuns();
  const h = hooks();
  const ctl = P.pausablePull(start, h);
  runs[0].exit({ ok: false, error: "HTTP 404" });
  assert.equal((await ctl.done).error, "HTTP 404");
  assert.deepEqual(h.paused, []);
});

test("Cancel deletes only the partial files in that model's folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "dl-pause-"));
  try {
    const model = join(dir, "qwen-3.5-4b");
    mkdirSync(model);
    for (const f of ["w.gguf", "w.gguf.part", "w.gguf.part.json", "mmproj-w.gguf.part", "notes.txt"]) writeFileSync(join(model, f), "x");
    const gone = P.removePartialDownloads(dir, "qwen-3.5-4b").sort();
    assert.deepEqual(gone, ["mmproj-w.gguf.part", "w.gguf.part", "w.gguf.part.json"]);
    assert.ok(existsSync(join(model, "w.gguf")));
    assert.ok(existsSync(join(model, "notes.txt")));
    assert.deepEqual(P.removePartialDownloads(dir, ".."), []);
    assert.deepEqual(P.removePartialDownloads(dir, "a/b"), []);
    assert.deepEqual(P.removePartialDownloads(dir, "missing"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* The agent's side, stood in for: like `atag models pull`, the run appends to
   `<file>.part` and asks for `Range: bytes=<.part size>-` when one is there
   (src/local-llm/downloads/download-resume.ts describeResume). The server
   sends the first half and then stalls, so the pause lands mid-file. */
test("after a pause the resumed pull asks for the rest from the partial's size", async () => {
  const body = Buffer.alloc(4096, 7);
  for (let i = 0; i < body.length; i++) body[i] = i % 251;
  const half = 1500;
  const ranges = [];
  const server = createServer((req, res) => {
    ranges.push(req.headers.range ?? null);
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    if (m) {
      const from = Number(m[1]);
      res.writeHead(206, { "content-range": `bytes ${from}-${body.length - 1}/${body.length}`, "content-length": body.length - from });
      res.end(body.subarray(from));
      return;
    }
    res.writeHead(200, { "content-length": body.length });
    res.write(body.subarray(0, half));   // then nothing: the pause stops it here
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/w.gguf`;
  const dir = mkdtempSync(join(tmpdir(), "dl-range-"));
  const dest = join(dir, "w.gguf");
  const part = `${dest}.part`;
  const size = () => (existsSync(part) ? statSync(part).size : 0);
  const start = () => {
    const ac = new AbortController();
    const done = (async () => {
      const offset = size();
      let out = null;
      try {
        const res = await fetch(url, { signal: ac.signal, headers: offset ? { Range: `bytes=${offset}-` } : {} });
        out = createWriteStream(part, { flags: "a" });
        for await (const chunk of res.body) out.write(chunk);
        await new Promise((r) => out.end(r));
        renameSync(part, dest);
        return { ok: true };
      } catch {
        if (out) await new Promise((r) => out.end(r));   // what came is on disk, as the agent's .part
        return { ok: false, error: "download exited with code null" };
      }
    })();
    return { done, cancel: () => ac.abort() };
  };
  try {
    const ctl = P.pausablePull(start, hooks());
    for (let i = 0; i < 200 && size() < half; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(size(), half);
    assert.equal(ctl.pause(), true);
    for (let i = 0; i < 200 && ctl.state() !== "paused"; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(ctl.state(), "paused");
    assert.equal(size(), half, "the partial file is kept, byte for byte");
    assert.equal(ctl.resume(), true);
    assert.deepEqual(await ctl.done, { ok: true });
    assert.deepEqual(ranges, [null, `bytes=${half}-`]);
    assert.ok(readFileSync(dest).equals(body), "the file is whole");
  } finally {
    server.closeAllConnections?.();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pauseFrame: what the window is told", () => {
  assert.deepEqual(P.pauseFrame("m", "running"), { id: "m", pausable: true, paused: false, pausing: false });
  assert.deepEqual(P.pauseFrame("m", "paused"), { id: "m", pausable: true, paused: true, pausing: false });
  assert.deepEqual(P.pauseFrame("m", "ended"), { id: null, pausable: false, paused: false, pausing: false });
  assert.deepEqual(P.pauseFrame(null, null), { id: null, pausable: false, paused: false, pausing: false });
});

test("the IPC answers for the slot's own download only", async () => {
  const handlers = {};
  const ipc = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const { start } = fakeRuns();
  const ctl = P.pausablePull(start, hooks());
  let quitting = false;
  registerDownloadPauseIpc(ipc, { slot: () => ({ id: "m", ctl }), quitting: () => quitting });
  assert.equal(handlers["cli:pausePull"]({}, "other").ok, false);
  assert.equal(handlers["cli:pausePull"]({}, "m").ok, true);
  await tick();
  assert.equal(handlers["cli:pullPauseState"]().paused, true);
  quitting = true;
  assert.equal(handlers["cli:resumePull"]({}, "m").ok, false);
  quitting = false;
  assert.equal(handlers["cli:resumePull"]({}, "m").ok, true);
});

/* ---- the card (renderer/dl-pause.js) ---- */

test("only main's pausable download row pauses; a paused one says so and offers Resume", () => {
  R.dlPauseApply({ id: "m", pausable: true, paused: false });
  const rows = () => [
    { src: "llm", kind: "weights", id: "m", state: "active", track: { totalBytes: 100, transferredBytes: 40, percent: 40 } },
    { src: "proj", kind: "projector", id: "m", state: "active" },
    { src: "llm", kind: "embedding", id: "m", state: "active" },
    { src: "dl", kind: "weights", id: "other", state: "active" },
  ];
  const ic = (n) => `<${n}>`;
  const running = R.dlPauseMark(rows());
  assert.deepEqual(running.map((r) => r.state), ["active", "active", "active", "active"]);
  assert.match(R.dlPauseBtnHTML(running[0], "Qwen", ic, String), /data-act="dlc:pause".*<pause>/);
  assert.equal(R.dlPauseBtnHTML(running[1], "Qwen", ic, String), "");
  assert.equal(R.dlPauseBtnHTML(running[2], "Qwen", ic, String), "");
  assert.equal(R.dlPauseBtnHTML(running[3], "Qwen", ic, String), "");

  assert.equal(R.dlPauseApply({ id: "m", pausable: true, paused: true }), true);
  const paused = R.dlPauseMark(rows());
  assert.deepEqual(paused.map((r) => r.state), ["paused", "active", "active", "active"]);
  assert.match(R.dlPauseBtnHTML(paused[0], "Qwen", ic, String), /data-act="dlc:resume".*<play>/);
  assert.equal(R.dlPausedLine(paused[0], 40, (a, b) => `${a} of ${b}`), "Paused · 40 of 100 · 40%");

  R.dlPauseApply({ id: null });
  assert.equal(R.dlPauseMark(rows())[0].state, "active");
});

test("Pause and Resume call main with the download's id, one press at a time", async () => {
  R.dlPauseApply({ id: "m", pausable: true });
  const calls = [];
  const br = { pausePull: (id) => { calls.push(["pause", id]); return Promise.resolve({ ok: false }); }, resumePull: (id) => { calls.push(["resume", id]); return Promise.resolve({ ok: true }); } };
  assert.equal(R.dlPauseAct("pause", br), true);
  assert.equal(R.dlPauseAct("pause", br), false, "busy until main answers");
  await tick(); await tick();
  assert.equal(R.DLP.busy, false, "a refusal frees the button");
  R.dlPauseAct("resume", br);
  assert.deepEqual(calls, [["pause", "m"], ["resume", "m"]]);
  R.dlPauseApply({ id: null });
});

test("index.html loads dl-pause.js before renderer.js, and renderer.js hooks it in", () => {
  const index = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  const at = index.indexOf('<script src="dl-pause.js">');
  assert.ok(at > 0 && at < index.indexOf('<script src="renderer.js">'));
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  for (const hook of ["dlPauseMark(rows)", "dlPauseBtnHTML(r, name, ic, esc)", "dlPausedLine(r, dlCardPercent(r), dlBytesPair)", "dlPauseAct(v, BR, renderDlcard)", "dlPauseInit(BR, renderDlcard)"]) {
    assert.ok(src.includes(hook), hook);
  }
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.ok(main.includes("if (pull.ctl) pull.ctl.discard();"), "the person's Cancel deletes the partial");
  assert.ok(main.includes("registerDownloadPauseIpc(ipcMain"));
});
