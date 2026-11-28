// ATO-2457: ui.render cards (renderer/ui-render.js, ui-render-act.js): the
// frame's spec checked again, drawn escaped by the window itself, and a
// click or a sent form handed to widgetDeliver as the person's message.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../renderer/ui-render.js");
// ui-render-act.js reads these as the page's globals.
Object.assign(globalThis, { UIR: R.UIR, uirBodyHTML: R.uirBodyHTML, uirEsc: R.uirEsc, uirMissing: R.uirMissing, uirMessage: R.uirMessage });
const delivered = [];
globalThis.widgetDeliver = (text, title) => { delivered.push({ text, title }); return "filled"; };
const A = require("../renderer/ui-render-act.js");

const frame = (ui, over = {}) => ({ tool: "ui.render", status: "ok", ui, ...over });
const DECISION = { kind: "decision", title: "Which plan?", options: [{ label: "Fast", description: "ships today" }, { label: "Safe", message: "Take the safe plan" }] };
const FORM = {
  kind: "form", title: "Trip", submit: "Book",
  fields: [
    { name: "city", label: "City", type: "text", required: true },
    { name: "class", label: "Class", type: "select", options: ["Economy", "Business"], value: "Business" },
    { name: "window", label: "Window seat", type: "checkbox", value: "true" },
    { name: "notes", label: "Notes", type: "textarea" },
  ],
};
const CARDS = { kind: "cards", title: "Flights", cards: [{ title: "AF 1234", meta: "09:10", action: { label: "Book", message: "Book AF 1234" } }, { title: "LH 99" }] };

beforeEach(() => { R.UIR.clear(); delivered.length = 0; });

const keyOf = (item) => item.uiCards[item.uiCards.length - 1];

test("only an ok ui.render frame with a usable spec is drawn", () => {
  assert.ok(R.uiSpecFromToolResult(frame(DECISION)));
  assert.equal(R.uiSpecFromToolResult(frame(DECISION, { status: "error" })), null);
  assert.equal(R.uiSpecFromToolResult(frame(DECISION, { tool: "canvas.render" })), null);
  assert.equal(R.uiSpecFromToolResult(frame({ ...DECISION, kind: "slider" })), null);
  assert.equal(R.uiSpecFromToolResult(frame({ ...DECISION, options: [{ label: "Only" }] })), null);
  assert.equal(R.uiSpecFromToolResult(frame({ kind: "form", title: "x", fields: [{ name: "a", label: "A", type: "select", options: [] }] })), null);
  assert.equal(R.uiSpecFromToolResult(frame({ ...DECISION, title: "  " })), null);
  const item = {};
  assert.equal(R.chatUiRender(item, frame(DECISION)), true);
  assert.equal(R.chatUiRender(item, { tool: "ui.render", status: "ok" }), false);
  assert.equal(item.uiCards.length, 1);
});

test("the card is the window's own markup: escaped, kept across repaints, no frame and no script", () => {
  const item = {};
  R.chatUiRender(item, frame({ ...DECISION, title: '<img src=x onerror="alert(1)">', options: [{ label: "<b>A</b>" }, { label: "B" }] }));
  const [html] = R.uiRenderSlots(item);
  assert.match(html, /data-morph-keep="uir:/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;b&gt;A&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<img|<b>|<iframe|<script|onerror="/);
  assert.match(html, /data-uirpng=/);
});

test("a decision's click sends the option's message, or its label, and marks it", () => {
  const item = {};
  R.chatUiRender(item, frame(DECISION));
  const key = keyOf(item);
  assert.equal(A.uirAct(key, { opt: "1" }), "filled");
  assert.deepEqual(delivered.pop(), { text: "Take the safe plan", title: "Which plan?" });
  A.uirAct(key, { opt: "0" });
  assert.equal(delivered.pop().text, "Fast");
  assert.equal(R.UIR.get(key).chosen, 0);
  assert.match(R.uirBodyHTML(R.UIR.get(key)), /class="uir-opt on" data-uir-opt="0" aria-pressed="true"/);
});

test("a form checks its required fields, then sends Label: value lines; it can be sent again", () => {
  const item = {};
  R.chatUiRender(item, frame(FORM));
  const key = keyOf(item);
  assert.equal(A.uirAct(key, { submit: true }), "none");
  assert.equal(delivered.length, 0);
  assert.match(R.UIR.get(key).err, /Fill in City first/);
  assert.equal(A.uirInput(key, "city", "Paris"), true);
  assert.equal(R.UIR.get(key).err, "");
  assert.equal(A.uirInput(key, "nope", "x"), false);
  assert.equal(A.uirAct(key, { submit: true }), "filled");
  assert.equal(delivered.pop().text, "Trip\nCity: Paris\nClass: Business\nWindow seat: yes");
  A.uirInput(key, "window", "false");
  A.uirInput(key, "notes", "aisle is fine too");
  A.uirAct(key, { submit: true });
  assert.equal(delivered.pop().text, "Trip\nCity: Paris\nClass: Business\nWindow seat: no\nNotes: aisle is fine too");
  // What was typed is drawn again on a full redraw.
  assert.match(R.uirBodyHTML(R.UIR.get(key)), /value="Paris"/);
});

test("a card's action sends its message; a card without one has no button", () => {
  const item = {};
  R.chatUiRender(item, frame(CARDS));
  const key = keyOf(item);
  const html = R.uirBodyHTML(R.UIR.get(key));
  assert.equal((html.match(/data-uir-card=/g) || []).length, 1);
  A.uirAct(key, { card: "0" });
  assert.equal(delivered.pop().text, "Book AF 1234");
  assert.equal(A.uirAct(key, { card: "1" }), "none");
});

test("a draft the person typed keeps the card unmarked", () => {
  globalThis.widgetDeliver = () => "draft";
  const item = {};
  R.chatUiRender(item, frame(DECISION));
  const key = keyOf(item);
  assert.equal(A.uirAct(key, { opt: "0" }), "draft");
  assert.equal(R.UIR.get(key).chosen, -1);
  globalThis.widgetDeliver = (text, title) => { delivered.push({ text, title }); return "filled"; };
});

test("renderer.js hooks the frame, the reply strip and the setting; index.html loads the files before renderer.js", () => {
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  const tr = src.slice(src.indexOf("if (ev.kind === 'tool_result') {"), src.indexOf("if (ev.kind === 'tool_update') {"));
  assert.match(tr, /if \(p\.ui && item && typeof chatUiRender === 'function'\) chatUiRender\(item, p\);/);
  assert.match(src, /if \(typeof uiRenderSlots === 'function'\) arts\.push\(\.\.\.uiRenderSlots\(m\)\);/);
  assert.match(src, /widgetSendRowHTML\(\{esc, setSwitchHTML\}\)/);
  assert.match(src, /if \(a === 'widgets:sendnow'\) \{ close\(\); widgetSendNowSet\(!widgetSendNowOn\(\)\); render\(\); return; \}/);
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  const at = (s) => html.indexOf(s);
  for (const f of ["widget-send.js", "mcp-app-bridge.js", "ui-render.js", "ui-render-act.js", "artifact-png.js"]) {
    assert.ok(at(`<script src="${f}"></script>`) > at('<script src="mcp-app.js"></script>'), f);
    assert.ok(at(`<script src="${f}"></script>`) < at('<script src="renderer.js"></script>'), f);
  }
  assert.ok(at('<script src="ui-render.js"></script>') < at('<script src="ui-render-act.js"></script>'));
  assert.ok(at('href="css/ui-render.css"') > 0);
});
