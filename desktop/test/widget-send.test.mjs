// ATO-2457: "Widgets send right away" (renderer/widget-send.js). Off by
// default: a widget's text waits in the box; on: it is sent as Enter would.
// A draft the person typed is never overwritten either way. Also the
// "Ask the agent to fix" text for a widget's script errors (artifact-bridge.js).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
const B = require("../renderer/artifact-bridge.js");
const W = require("../renderer/widget-send.js");

const toasts = [];
const sends = [];
const entry = { value: "", setSelectionRange() {}, style: {} };
globalThis.S = { draft: "" };
globalThis.$ = (sel) => (sel === "#entry" ? entry : null);
globalThis.autosize = () => {};
globalThis.toast = (t, s, kind) => toasts.push({ t, s, kind });
globalThis.abFillComposer = B.abFillComposer;
globalThis.AB = B.AB;
globalThis.submit = () => { sends.push(entry.value); entry.value = ""; S.draft = ""; };

beforeEach(() => { W.widgetSendNowSet(false); B.AB.lastFill = ""; entry.value = ""; S.draft = ""; toasts.length = 0; sends.length = 0; });

test("off by default: the text waits in the box with a press-Enter toast, nothing is sent", () => {
  store.clear();
  assert.equal(W.widgetSendNowOn(), false);
  assert.equal(W.widgetDeliver("Laptop B", "Pick a laptop"), "filled");
  assert.equal(entry.value, "Laptop B");
  assert.equal(sends.length, 0);
  assert.match(toasts.pop().s, /Press Enter/);
});

test("on: the text is sent at once, without the press-Enter toast, and the choice is kept", () => {
  W.widgetSendNowSet(true);
  assert.equal(store.get(W.WIDGET_SEND_KEY), "1");
  assert.equal(W.widgetDeliver("Laptop B", "Pick a laptop"), "sent");
  assert.deepEqual(sends, ["Laptop B"]);
  assert.equal(toasts.length, 0);
  // The next widget's text is not mistaken for the person's own draft.
  assert.equal(W.widgetDeliver("Laptop C", "Pick a laptop"), "sent");
  assert.deepEqual(sends, ["Laptop B", "Laptop C"]);
});

test("on or off, the person's own draft stays and nothing is sent", () => {
  for (const on of [false, true]) {
    W.widgetSendNowSet(on);
    entry.value = "my own words"; S.draft = "my own words"; toasts.length = 0;
    assert.equal(W.widgetDeliver("Laptop B", "Pick a laptop"), "draft");
    assert.equal(entry.value, "my own words");
    assert.equal(sends.length, 0);
    assert.equal(toasts.pop().kind, "bad");
  }
});

test("the Settings row names the switch and its act", () => {
  const html = W.widgetSendRowHTML({ setSwitchHTML: (o) => `<sw on=${o.on} act=${o.act}>` });
  assert.match(html, /Widgets send right away/);
  assert.match(html, /<sw on=false act=widgets:sendnow>/);
});

test("a page's errors become a message asking the agent to fix it", () => {
  const key = "canvas:s1:calc";
  B.AB.arts = new Map([[key, { key, title: "Calculator", node: null }]]);
  B.AB.widgets.clear();
  assert.equal(B.abFixMessage(key), "");
  B.abWidget(key).errors.push({ message: "x is not defined", line: 4 });
  assert.equal(B.abFixMessage(key), 'The page "Calculator" shows script errors:\nScript error (line 4): x is not defined\nPlease fix the page and show it again.');
});
