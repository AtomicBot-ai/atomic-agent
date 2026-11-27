// ATO-2513: the bubble's keys never answer a request the person did not
// pick. renderer/pet.js petBoot runs in a vm with a small fake page and a
// fake bridge: a held Enter, a second tap, or Enter right after the shown
// request changed must not approve the next one in the queue.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const P = require("../renderer/pet.js");
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const req = (id) => ({ approvalId: id, tool: "shell.exec", text: "run " + id, risk: "", question: false, canAllow: true });
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function el(doc, id) {
  const listeners = {};
  return {
    id, hidden: false, textContent: "", disabled: false, title: "", src: "",
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type, ev = {}) { for (const fn of listeners[type] || []) fn({ button: 0, preventDefault() {}, ...ev }); },
    focus() { doc.activeElement = this; },
    contains(other) { return other === this; },
    setPointerCapture() {},
  };
}

function boot(onAnswer) {
  const listeners = { doc: {}, win: {} };
  const on = (bag) => (type, fn) => { (bag[type] ||= []).push(fn); };
  const doc = { body: { className: "" }, activeElement: null, addEventListener: on(listeners.doc) };
  const ids = ["pet", "bubble", "skin", "badge", "b-title", "b-text", "b-detail", "b-risk", "b-msg", "b-allow", "b-deny", "b-open", "b-more", "b-keys", "b-close"];
  const els = Object.fromEntries(ids.map((id) => [id, el(doc, id)]));
  doc.getElementById = (id) => els[id] || null;
  const answers = [];
  const focus = [];
  let viewCb = null;
  const BR = {
    answer: (approvalId, decision) => { answers.push([approvalId, decision]); return onAnswer({ approvalId, decision, show }); },
    focus: (on) => focus.push(on),
    open() {}, hover() {}, drag() {}, menu() {},
    onView: (cb) => { viewCb = cb; },
    attach: () => Promise.resolve(null),
  };
  const ctx = { console, clock: 10_000, document: doc, window: { atomic: { pet: BR }, addEventListener: on(listeners.win) } };
  vm.createContext(ctx);
  vm.runInContext("Date.now = () => clock;", ctx);
  vm.runInContext(read("../renderer/pet.js"), ctx, { filename: "pet.js" });
  function show(id, more = 0) { viewCb({ state: id ? "waiting" : "idle", dnd: false, approval: id ? req(id) : null, more }); }
  const key = (k, repeat = false) => { for (const fn of listeners.doc.keydown || []) fn({ key: k, repeat, preventDefault() {} }); };
  const later = (ms) => { ctx.clock += ms; };
  return { els, answers, focus, show, key, later, click: () => els.bubble.fire("pointerdown") };
}

/** The bridge as main behaves: the next request's view arrives before the answer's reply. */
const nextFirst = (next) => ({ approvalId, show }) => {
  if (approvalId === "A") show(next);
  return Promise.resolve({ ok: true });
};

test("a held Enter answers the request it was pressed for, never the next one", async () => {
  const p = boot(nextFirst("B"));
  p.show("A", 1);
  p.later(1000);
  p.click();
  p.key("Enter");
  await settle();
  assert.equal(p.els["b-text"].textContent, "run B", "the bubble now shows B");
  p.key("Enter", true);
  p.key("Enter", true);
  await settle();
  assert.deepEqual(p.answers, [["A", "allow"]], "auto-repeat did not reach B");
});

test("a second tap of Enter or Esc after the answer does not touch the next request", async () => {
  const p = boot(nextFirst("B"));
  p.show("A", 1);
  p.later(1000);
  p.click();
  p.key("Enter");
  await settle();
  p.later(1000);
  p.key("Enter");
  p.key("Escape");
  await settle();
  assert.deepEqual(p.answers, [["A", "allow"]]);
  assert.equal(p.focus.at(-1), false, "the keyboard went back with the request it was taken for");
  // B needs its own click, then its keys work.
  p.click();
  p.key("Escape");
  await settle();
  assert.deepEqual(p.answers, [["A", "allow"], ["B", "deny"]]);
});

test("the shown request changing under a focused bubble drops the keys", async () => {
  const p = boot(() => Promise.resolve({ ok: true }));
  p.show("A", 1);
  p.later(1000);
  p.click();
  p.show("B");   // A was answered in the window, or its turn ended
  p.later(1000);
  p.key("Enter");
  p.key("Escape");
  await settle();
  assert.deepEqual(p.answers, []);
});

test("a key right after a request appears waits until it has been on screen a moment", async () => {
  const p = boot(() => Promise.resolve({ ok: true }));
  p.show("A");
  p.click();
  p.later(P.PET_KEY_ARM_MS - 1);
  p.key("Enter");
  await settle();
  assert.deepEqual(p.answers, []);
  p.later(1);
  p.key("Enter");
  await settle();
  assert.deepEqual(p.answers, [["A", "allow"]]);
});

test("Enter or Space on a focused Deny button is held to the same rule; a mouse click is not", async () => {
  const p = boot(() => Promise.resolve({ ok: true }));
  p.show("A");
  p.later(1000);
  p.click();
  p.show("B");
  p.later(1000);
  p.els["b-deny"].fire("click", { detail: 0 });
  await settle();
  assert.deepEqual(p.answers, [], "a keyboard click for a request nobody picked");
  p.els["b-deny"].fire("click", { detail: 1 });
  await settle();
  assert.deepEqual(p.answers, [["B", "deny"]], "the mouse still answers what it clicked");
});

test("petKeyArmed: no repeat, the picked request only, after the arm time", () => {
  const m = { approvalId: "A" };
  assert.equal(P.petKeyArmed(false, m, "A", 0, P.PET_KEY_ARM_MS), true);
  assert.equal(P.petKeyArmed(true, m, "A", 0, 10_000), false);
  assert.equal(P.petKeyArmed(false, m, "B", 0, 10_000), false);
  assert.equal(P.petKeyArmed(false, m, null, 0, 10_000), false);
  assert.equal(P.petKeyArmed(false, null, "A", 0, 10_000), false);
  assert.equal(P.petKeyArmed(false, m, "A", 0, P.PET_KEY_ARM_MS - 1), false);
});

test("main answers only the request its last view showed, not any waiting id", () => {
  const src = read("../main/pet-ipc.ts");
  assert.match(src, /shownId = v\.approval\?\.approvalId \?\? null;/, "view() remembers what the bubble shows");
  assert.match(src, /const shown = shownId \? tracker\.approval\(shownId\) : null;/, "pet:answer looks up that one");
  assert.doesNotMatch(src, /tracker\.approval\(id\)/, "never the id the page sent");
});
