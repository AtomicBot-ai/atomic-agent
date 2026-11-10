// ATO-1342: the time left on the download card jumped around (15% 5 min,
// 20% 9 min, 25% 2 min, 30% under a minute, 30% 4 min) on a download that took
// about 3 minutes. `models pull` writes a line for every progress tick while
// the percent is a multiple of 5, with bytes rounded to 0.01 GB, and the rate
// was taken between any two lines.
//
// renderer.js is read as text; dlRateStep and dlEtaFrom run in a vm context
// with a clock the test moves. No deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");

function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}
function constLine(name) {
  const at = source.indexOf("\nconst " + name + " = ");
  assert.ok(at >= 0, name + " is a top-level const in renderer.js");
  return source.slice(at + 1, source.indexOf("\n", at + 1) + 1);
}

function meter() {
  const clock = { ms: 0 };
  const c = vm.createContext({ Date: { now: () => clock.ms }, Math });
  for (const name of ["DL_RATE_MIN_SECONDS", "DL_RATE_STALL_SECONDS", "DL_RATE_MIN_BYTES"]) {
    vm.runInContext(constLine(name).replace(/^const /, "var "), c);
  }
  for (const name of ["dlRateStep", "dlEtaFrom"]) vm.runInContext(fn(name), c);
  const holder = { rate: null, last: null, samples: 0 };
  return {
    holder,
    at(seconds, bytes) { clock.ms = seconds * 1000; c.dlRateStep(holder, bytes); },
    eta(done, total) { return c.dlEtaFrom(done, total, holder.rate, holder.samples); },
  };
}

const GIB = 1024 * 1024 * 1024;
// What main's parsePullProgress gets back from the CLI's two-decimal line.
const asPrinted = (bytes) => Math.round(Number((bytes / GIB).toFixed(2)) * GIB);

test("a steady download keeps a steady estimate through the bursts of lines", () => {
  const m = meter();
  const total = 5 * GIB;
  const speed = 28 * 1024 * 1024;
  let shown = 0;
  // A progress tick every 200 ms; a line only while the percent is a multiple of 5.
  for (let t = 0.2; t * speed < total; t += 0.2) {
    const real = t * speed;
    const percent = Math.floor((real / total) * 100);
    if (percent % 5 !== 0) continue;
    const done = asPrinted(real);
    m.at(t, done);
    const eta = m.eta(done, total);
    if (eta === null) continue;
    shown += 1;
    const truth = (total - real) / speed;
    assert.ok(eta > truth * 0.75 && eta < truth * 1.3,
      `at ${percent}% (${t.toFixed(1)} s) it said ${eta} s, the truth is ${Math.round(truth)} s`);
  }
  assert.ok(shown > 20, `an estimate was on screen for ${shown} lines`);
});

test("lines a moment apart are not a speed", () => {
  const m = meter();
  m.at(0, 0);
  m.at(0.005, 100 * 1024 * 1024);
  m.at(1, 110 * 1024 * 1024);
  assert.equal(m.holder.rate, null);
  assert.equal(m.holder.samples, 0);
  // The bytes of those lines are not lost: the slope spans the whole stretch.
  m.at(10, 200 * 1024 * 1024);
  assert.equal(m.holder.rate, 20 * 1024 * 1024);
});

// Small counts below are in MiB: a slope spans at least four 0.01 GB steps (DL_RATE_MIN_BYTES).
const U = 1024 * 1024;

test("unmoved lines do not drag the rate towards zero", () => {
  const m = meter();
  m.at(0, 0);
  m.at(10, 100 * U);
  m.at(20, 200 * U);
  const before = m.holder.rate;
  assert.ok(before > 0);
  m.at(30, 200 * U);
  m.at(40, 200 * U);
  assert.equal(m.holder.rate, before);
});

test("a long stall drops the estimate, and it comes back when the bytes move", () => {
  const m = meter();
  m.at(0, 0);
  m.at(10, 100 * U);
  m.at(20, 200 * U);
  assert.ok(m.eta(200 * U, 1000 * U) > 0);
  m.at(80, 200 * U);
  assert.ok(m.holder.rate > 0, "a minute is not a stall: slow links step that slowly");
  m.at(330, 200 * U);
  assert.equal(m.holder.rate, null);
  assert.equal(m.eta(200 * U, 1000 * U), null);
  // The slope spans from the first sight of those bytes, the stall included.
  m.at(340, 3400 * U);
  assert.equal(m.holder.rate, 10 * U);
  m.at(350, 4400 * U);
  assert.equal(m.holder.samples, 2);
});

test("a slope over one rounded step is not a speed", () => {
  const m = meter();
  m.at(0, 0);
  m.at(100, 100 * U);
  const before = m.holder.rate;
  // The next 0.01 GB step, 4 s later: 2.5 GB/s if it counted.
  m.at(104, 110 * U);
  assert.equal(m.holder.rate, before);
});

test("a slow link (100 KB/s, bytes in 0.01 GB steps) keeps an estimate near the truth", () => {
  const m = meter();
  const total = 1.3 * GIB;
  const speed = 100 * 1024;
  let shown = 0;
  let blank = 0;
  // A progress tick every second; a line only while the percent is a multiple of 5.
  for (let t = 1; t * speed < total; t += 1) {
    const real = t * speed;
    const percent = Math.floor((real / total) * 100);
    if (percent % 5 !== 0) continue;
    const done = asPrinted(real);
    m.at(t, done);
    const eta = m.eta(done, total);
    if (eta === null) { if (shown) blank += 1; continue; }
    shown += 1;
    const truth = (total - real) / speed;
    assert.ok(eta > truth * 0.7 && eta < truth * 1.4,
      `at ${percent}% (${t} s) it said ${eta} s, the truth is ${Math.round(truth)} s`);
  }
  assert.ok(shown > 100, `an estimate was on screen for ${shown} lines`);
  assert.equal(blank, 0, "once shown, the estimate does not blink off");
});

test("a counter that goes back carries nothing over", () => {
  const m = meter();
  m.at(0, 0);
  m.at(10, 5000 * U);
  m.at(20, 10000 * U);
  m.at(30, 400 * U);
  assert.equal(m.holder.rate, null);
  assert.equal(m.holder.samples, 0);
  assert.deepEqual({ ...m.holder.last }, { bytes: 400 * U, at: 30000 });
});
