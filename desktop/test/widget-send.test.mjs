// ATO-2457: "Widgets send right away" (renderer/widget-send.js). Off by
// default: a widget's text waits in the box; on: it is sent as Enter would.
// A draft the person typed is never overwritten either way. Also the
// "Ask the agent to fix" text for a widget's script errors (artifact-bridge.js).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

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
const calls = [];
const sendingSubmit = (prepared, opts) => { calls.push({ text: entry.value, plain: W.widgetTextIsPlain(entry.value), opts }); sends.push(entry.value); entry.value = ""; S.draft = ""; };
globalThis.submit = sendingSubmit;

beforeEach(() => { globalThis.submit = sendingSubmit; calls.length = 0; W.WIDGET_SEND.plain = ""; W.widgetSendNowSet(false); B.AB.lastFill = ""; entry.value = ""; S.draft = ""; toasts.length = 0; sends.length = 0; });

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

test("on: a widget's /command or !command goes out as a plain message, chips left for the person", () => {
  W.widgetSendNowSet(true);
  for (const text of ["/runmode cloud", "!rm -rf ~", "  /quit"]) {
    assert.equal(W.widgetDeliver(text, "Continue?"), "sent");
    const c = calls.pop();
    assert.equal(c.plain, true, "submit() is told this box text is a widget's message: " + text);
    assert.deepEqual(c.opts, { plain: true });
  }
  // Sent, so the mark is gone: the person typing the same words later gets the command.
  assert.equal(W.widgetTextIsPlain("/quit"), false);
});

test("off: a widget's /command waits in the box marked as a message; edited, it is the person's own again", () => {
  assert.equal(W.widgetDeliver("/runmode cloud", "Continue?"), "filled");
  assert.equal(entry.value, "/runmode cloud");
  assert.equal(W.widgetTextIsPlain(entry.value), true);
  assert.equal(W.widgetTextIsPlain("/runmode cloud now"), false);
  assert.equal(W.widgetTextIsPlain("/clear"), false);
  assert.equal(W.widgetTextIsPlain(""), false);
});

test("on, but submit() keeps the text (agent starting, voice, full queue): not 'sent', and the next widget still fills", () => {
  W.widgetSendNowSet(true);
  globalThis.submit = () => {};   // held: the box keeps its text
  assert.equal(W.widgetDeliver("Laptop B", "Pick a laptop"), "filled");
  assert.equal(entry.value, "Laptop B");
  assert.equal(B.AB.lastFill, "Laptop B");
  assert.equal(W.widgetDeliver("Laptop C", "Pick a laptop"), "filled", "not mistaken for the person's draft");
  assert.equal(entry.value, "Laptop C");
});

/* The real submit() from renderer.js, run with its neighbours stubbed. It
   stops at "the agent is still starting", the first hold of the message
   path, so reaching that toast means the text was taken as a message. */
const rendererSrc = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
function submitSource() {
  const at = rendererSrc.indexOf("\nfunction submit(");
  assert.ok(at >= 0, "submit is a top-level function in renderer.js");
  return rendererSrc.slice(at + 1, rendererSrc.indexOf("\n}\n", at) + 2);
}
function runRealSubmit(boxText) {
  const did = [];
  const box = { value: boxText };
  const c = vm.createContext({
    VOICE: { state: "" }, voiceStop() {}, $: (sel) => (sel === "#entry" ? box : null),
    S: { draft: boxText, slash: false, busy: false, pending: false, live: { state: "starting" }, log: [], queued: [] },
    bangCommandOf: (t) => (t.startsWith("!") ? t.slice(1) : null), bangTerminalOk: () => true,
    bangOpen: (cmd) => did.push("bang:" + cmd), workingDir: () => "/w",
    autosize() {}, ctxDraftChanged() {}, render() {}, refreshSend() {},
    attPreparing: () => false, attComposeMessage: (t) => t,
    BSW: { gating: false }, SK: { workingDir: "/w" }, SLASH: [["quit"], ["runmode"]],
    submitSkillCommand: (t) => did.push("skill:" + t), runSlash: (a) => did.push("slash:" + a.join(" ")),
    openHoldsComposer: () => false, OPENING: {}, swxWaitsForRoute: () => false, DRAIN_OWED: false, SWX: {},
    toast: (t) => did.push("toast:" + t), widgetTextIsPlain: W.widgetTextIsPlain,
  });
  vm.runInContext(submitSource() + "globalThis.submit = submit;", c);
  c.submit();
  return did;
}

test("renderer submit(): a widget's /command or !command left in the box is sent as a message, not run", () => {
  for (const text of ["/runmode cloud", "/my-skill do it", "!rm -rf ~"]) {
    assert.equal(W.widgetDeliver(text, "Continue?"), "filled");
    assert.deepEqual(runRealSubmit(text), ["toast:The agent is still starting"], text);
  }
  // The same words typed by the person (no widget mark) still run as commands.
  W.WIDGET_SEND.plain = "";
  assert.deepEqual(runRealSubmit("/runmode cloud"), ["slash:runmode cloud"]);
  assert.deepEqual(runRealSubmit("!ls"), ["bang:ls"]);
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
