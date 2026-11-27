// ATO-2534: the "● Logbook" chip and its menu (renderer/logbook-chip.js):
// shown only while the logbook is on or paused, its clicks, its errors,
// and its report of whether it is on screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const reports = [];
const acts = [];
let answer = { ok: true, view: { state: "paused", pausedUntil: null, intervalMinutes: 5, notesToday: 0 } };
let chipInDom = false;
let visibility = "visible";
const root = { id: "lbk-root", innerHTML: "" };
globalThis.document = {
  get visibilityState() { return visibility; },
  getElementById: (id) => (id === "lbk-root" ? root : null),
  querySelector: (sel) => (sel === ".lbkchip" && chipInDom ? { getBoundingClientRect: () => ({ bottom: 40, right: 900 }) } : null),
  createElement: () => root,
  body: { appendChild: () => {} },
};
globalThis.window = { innerWidth: 1000 };
globalThis.BR = {
  logbookStatus: async () => ({ ok: true, view: null }),
  logbookAct: async (action, minutes) => { acts.push([action, minutes]); return answer; },
  logbookChipVisible: (v) => reports.push(v),
};
let toolbarDraws = 0;
globalThis.renderToolbar = () => { toolbarDraws++; chipInDom = L.logbookChipHTML() !== ""; };

const L = require("../renderer/logbook-chip.js");
const ON = { state: "on", pausedUntil: null, intervalMinutes: 5, notesToday: 2, lastOutcome: null, lastReason: null };

test("no chip while the logbook is off or the agent has no logbook", () => {
  L.lbkSet(null);
  assert.equal(L.logbookChipHTML(), "");
  L.lbkSet({ ...ON, state: "off" });
  assert.equal(L.logbookChipHTML(), "");
});

test("the chip shows while on, redraws the toolbar once, and tells main it is on screen", () => {
  reports.length = 0;
  const before = toolbarDraws;
  L.lbkSet(ON);
  assert.match(L.logbookChipHTML(), /class="lbkchip"[^>]*data-lbk="menu"/);
  assert.match(L.logbookChipHTML(), />Logbook<\/button>$/);
  assert.equal(toolbarDraws, before + 1);
  L.lbkSet(ON);
  assert.equal(toolbarDraws, before + 1, "the same state draws nothing again");
  assert.deepEqual(reports, [true]);
});

test("a hidden window says the chip is not on screen, so the runtime stops capturing", () => {
  reports.length = 0;
  visibility = "hidden";
  L.lbkReport(true);
  assert.deepEqual(reports, [false]);
  visibility = "visible";
  L.lbkReport(true);
  assert.deepEqual(reports, [false, true]);
});

test("the menu offers Pause while on, and a click pauses through main", async () => {
  L.LBK.open = true;
  assert.match(L.lbkMenuHTML(), /data-lbk="pause:30"[^>]*>Pause for 30 minutes/);
  assert.match(L.lbkMenuHTML(), /data-lbk="stop"[^>]*>Stop the logbook/);
  assert.doesNotMatch(L.lbkMenuHTML(), /Resume/);
  await L.lbkAct("pause:30");
  assert.deepEqual(acts.at(-1), ["pause", 30]);
  assert.equal(L.LBK.open, false, "closes after it worked");
  assert.match(L.logbookChipHTML(), /Logbook paused/);
});

test("a refused click says so in plain words, the runtime's sentence behind Details", async () => {
  answer = { ok: false, error: "The logbook is already off." };
  L.LBK.open = true;
  await L.lbkAct("stop");
  const html = L.lbkMenuHTML();
  assert.match(html, /Could not stop the logbook\./);
  assert.doesNotMatch(html, /already off/, "details stay folded");
  L.LBK.details = true;
  assert.match(L.lbkMenuHTML(), /The logbook is already off\./);
});
