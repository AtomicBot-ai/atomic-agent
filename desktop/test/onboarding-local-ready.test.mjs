// ATO-822 item 5: setup said "Local model ready" as soon as a local model was
// picked, even when its server then failed to start. The line now follows
// the start the switch reported: ready only after a real start.
//
// renderer.js is read as text; obLocalStartOf, obConfiguredLabel and
// obConfiguredHTML run in a vm context. No deps, no build.
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

function screen(outcome, res) {
  const c = vm.createContext({
    OB: { outcome, localStart: null },
    OB_COPY: { cloudReadyLabel: "Cloud model ready" },
    esc: (s) => String(s),
    ic: (name) => "<i:" + name + ">",
  });
  for (const name of ["obLocalStartOf", "obConfiguredLabel", "obReadyHTML", "obConfiguredHTML"]) vm.runInContext(fn(name), c);
  if (res !== undefined) c.OB.localStart = c.obLocalStartOf(res);
  return { label: c.obConfiguredLabel(), html: c.obConfiguredHTML() };
}

test("ready only after the model server really started", () => {
  for (const daemon of ["started", "restarted", "untouched"]) {
    const s = screen("local", { ok: true, daemon });
    assert.equal(s.label, "Local model ready", daemon);
    assert.match(s.html, /<i:check>/);
  }
});

test("a start that failed is not called ready, and carries no green tick", () => {
  const s = screen("local", { ok: true, daemon: "start-failed", error: "port 19091 is already served" });
  assert.equal(s.label, "Local model selected, but it did not start");
  assert.doesNotMatch(s.html, /<i:check>/);
  assert.match(s.html, /<i:alert>/);
});

test("a pick whose start was not seen says selected, not ready", () => {
  for (const res of [undefined, { ok: true, daemon: "skipped" }, { ok: true, daemon: "superseded" }, { ok: true }]) {
    const s = screen("local", res);
    assert.equal(s.label, "Local model selected");
    assert.doesNotMatch(s.html, /<i:check>/);
  }
});

test("cloud and other outcomes are unchanged", () => {
  assert.equal(screen("cloud").label, "Cloud model ready");
  assert.match(screen("cloud").html, /<i:check>/);
  assert.equal(screen("custom").label, "Backend ready");
});
