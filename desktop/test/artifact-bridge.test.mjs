// ATO-2375: a widget page's messages (renderer/artifact-bridge.js): only from
// our frames, checked, capped and rate-limited; a prompt fills the message box
// (the person sends it), state is kept per artifact, errors go on the card.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const B = require("../renderer/artifact-bridge.js");

// The renderer globals the fill reads at call time.
const toasts = [];
const entry = { value: "", focused: false, focus() { this.focused = true; }, setSelectionRange() {}, style: {} };
globalThis.S = { draft: "" };
globalThis.$ = (sel) => (sel === "#entry" ? entry : null);
globalThis.autosize = () => {};
globalThis.toast = (t, s, kind) => toasts.push({ t, s, kind });
// Focus: msg() puts it in the sending frame (the person clicked there); a test may move it.
const doc = { activeElement: null, querySelectorAll() { return []; } };
globalThis.document = doc;

/** A frame of ours, as CHAT_ART keeps it. */
function frame(key, url, title) {
  const win = { got: [], postMessage(m, o) { this.got.push({ m, o }); } };
  return { key, url, title, node: { contentWindow: win }, win };
}
let a, b;
beforeEach(() => {
  B.AB.widgets.clear();
  B.AB.lastFill = "";
  a = frame("canvas:s1:laptops", "atomic-art://" + "a".repeat(32) + "/", "Pick a laptop");
  b = frame("canvas:s1:calc", "atomic-art://" + "b".repeat(32) + "/", "Calculator");
  B.AB.arts = new Map([[a.key, a], [b.key, b]]);
  entry.value = ""; entry.focused = false; S.draft = ""; toasts.length = 0;
});
const msg = (from, data) => { doc.activeElement = from.node; return { source: from.win, data }; };

test("validators: prompt text, state JSON and error lines are checked and capped", () => {
  assert.equal(B.abPromptText("  Laptop B  "), "Laptop B");
  assert.equal(B.abPromptText("   "), null);
  assert.equal(B.abPromptText(42), null);
  assert.equal(B.abPromptText("x".repeat(B.AB_PROMPT_MAX + 10)).length, B.AB_PROMPT_MAX);
  assert.deepEqual(B.abStateOf("{\"n\":1}"), { json: "{\"n\":1}", value: { n: 1 } });
  assert.equal(B.abStateOf("{nope"), null);
  assert.equal(B.abStateOf({ n: 1 }), null, "only the JSON string the bridge posts");
  assert.equal(B.abStateOf("\"" + "x".repeat(B.AB_STATE_MAX) + "\""), null, "over 64 KB");
  assert.deepEqual(B.abErrorOf({ message: "  TypeError:\n x  ", line: 7.9 }), { message: "TypeError: x", line: 7 });
  assert.equal(B.abErrorOf({ message: "" }), null);
  assert.equal(B.abErrorOf({ message: "e".repeat(999) }).message.length, B.AB_ERROR_MAX);
  assert.equal(B.abErrorOf({ message: "e", line: -3 }).line, 0);
});

test("a message from a frame that is not ours, or of another kind, is ignored", () => {
  assert.equal(B.artifactBridgeMessage({ source: {}, data: { atomicArtifact: "prompt", text: "hi" } }, 10_000), false);
  assert.equal(B.artifactBridgeMessage(msg(a, { atomicArtifact: "size", h: 300 }), 10_000), false);
  assert.equal(B.artifactBridgeMessage(msg(a, "prompt"), 10_000), false);
  assert.equal(entry.value, "");
});

test("a prompt fills the message box, leaves focus in the widget, never sends; one per 2 s per widget", () => {
  assert.equal(B.artifactBridgeMessage(msg(a, { atomicArtifact: "prompt", text: "I pick laptop B" }), 10_000), true);
  assert.equal(entry.value, "I pick laptop B");
  assert.equal(S.draft, "I pick laptop B");
  assert.equal(entry.focused, false, "the box does not take focus: a key press there must not count as a click in the widget");
  assert.match(toasts.at(-1).t, /"Pick a laptop"/);
  assert.match(toasts.at(-1).s, /Press Enter/);
  // Too soon from the same widget: nothing changes.
  assert.equal(B.artifactBridgeMessage(msg(a, { atomicArtifact: "prompt", text: "Laptop C" }), 11_000), false);
  assert.equal(entry.value, "I pick laptop B");
  // Another widget is not held up; the text the last widget put there is replaced.
  assert.equal(B.artifactBridgeMessage(msg(b, { atomicArtifact: "prompt", text: "2+2=4" }), 11_000), true);
  assert.equal(entry.value, "2+2=4");
  assert.equal(B.artifactBridgeMessage(msg(a, { atomicArtifact: "prompt", text: "Laptop C" }), 12_500), true);
  assert.equal(entry.value, "Laptop C");
  // Nothing here submits: the module has no reference to submit().
  assert.doesNotMatch(readFileSync(new URL("../renderer/artifact-bridge.js", import.meta.url), "utf8"), /submit\(/);
});

test("the person's own draft is never overwritten", () => {
  entry.value = "my half-written question";
  assert.equal(B.artifactBridgeMessage(msg(a, { atomicArtifact: "prompt", text: "Laptop B" }), 10_000), true);
  assert.equal(entry.value, "my half-written question");
  assert.equal(toasts.at(-1).kind, "bad");
});

test("a prompt without a click or key press in the page fills nothing", () => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { userActivation: { isActive: false } }, configurable: true });
  try {
    assert.equal(B.artifactBridgeMessage(msg(a, { atomicArtifact: "prompt", text: "spam" }), 10_000), false);
    assert.equal(entry.value, "");
  } finally {
    if (nav) Object.defineProperty(globalThis, "navigator", nav); else delete globalThis.navigator;
  }
});

test("a prompt while focus is outside this widget fills nothing, even with the window active", () => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { userActivation: { isActive: true } }, configurable: true });
  try {
    // The person typed in the message box (window active), the page posts on a timer.
    const m = msg(a, { atomicArtifact: "prompt", text: "spam" });
    doc.activeElement = entry;
    assert.equal(B.artifactBridgeMessage(m, 10_000), false);
    assert.equal(entry.value, "");
    // Focus in the other widget does not count for this one.
    doc.activeElement = b.node;
    assert.equal(B.artifactBridgeMessage({ source: a.win, data: { atomicArtifact: "prompt", text: "spam" } }, 20_000), false);
    assert.equal(entry.value, "");
    // A click in this widget does.
    assert.equal(B.artifactBridgeMessage(msg(a, { atomicArtifact: "prompt", text: "Laptop B" }), 30_000), true);
    assert.equal(entry.value, "Laptop B");
  } finally {
    if (nav) Object.defineProperty(globalThis, "navigator", nav); else delete globalThis.navigator;
  }
});

test("state is kept per artifact and sent back when its page says ready", () => {
  assert.equal(B.artifactBridgeMessage(msg(a, { atomicArtifact: "state", json: "{\"pick\":\"B\"}" })), true);
  assert.equal(B.artifactBridgeMessage(msg(a, { atomicArtifact: "state", json: "{bad" })), false);
  assert.equal(B.artifactBridgeMessage(msg(a, { atomicArtifact: "state", json: "\"" + "x".repeat(B.AB_STATE_MAX) + "\"" })), false);
  assert.equal(B.artifactBridgeMessage(msg(a, { atomicArtifact: "ready" })), true);
  assert.deepEqual(a.win.got.at(-1), { m: { atomicWidget: "state", state: { pick: "B" } }, o: "*" });
  // The other widget has its own (none yet).
  B.artifactBridgeMessage(msg(b, { atomicArtifact: "ready" }));
  assert.deepEqual(b.win.got.at(-1).m, { atomicWidget: "state", state: null });
  // A new page for the same artifact (a reload, the canvas) gets it back too.
  a.url = "atomic-art://" + "c".repeat(32) + "/";
  B.artifactBridgeMessage(msg(a, { atomicArtifact: "ready" }));
  assert.deepEqual(a.win.got.at(-1).m.state, { pick: "B" });
});

test("errors: three per page kept, repeats once, cleared by a new page", () => {
  for (const m of ["one", "one", "two", "three", "four"]) B.artifactBridgeMessage(msg(a, { atomicArtifact: "error", message: m, line: 1 }));
  assert.deepEqual(B.AB.widgets.get(a.key).errors.map((x) => x.message), ["one", "two", "three"]);
  a.url = "atomic-art://" + "d".repeat(32) + "/";
  B.artifactBridgeMessage(msg(a, { atomicArtifact: "ready" }));
  assert.deepEqual(B.AB.widgets.get(a.key).errors, []);
});

test("the oldest widget's state goes past the cap", () => {
  for (let i = 0; i < B.AB_MAX_KEYS + 5; i++) B.abWidget("k" + i);
  assert.equal(B.AB.widgets.size, B.AB_MAX_KEYS);
  assert.equal(B.AB.widgets.has("k0"), false);
});

test("the bridge loads after chat-artifact.js and before renderer.js, with its style", () => {
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  const at = (s) => html.indexOf(s);
  assert.ok(at('<script src="artifact-bridge.js"></script>') > at('<script src="chat-artifact.js"></script>'));
  assert.ok(at('<script src="artifact-bridge.js"></script>') < at('<script src="renderer.js"></script>'));
  assert.ok(at('href="css/artifact-bridge.css"') > 0);
});
