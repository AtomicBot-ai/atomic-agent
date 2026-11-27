// ATO-2478: a toast with one button (renderer/toast-actions.js) and its hook in renderer.js toastHTML.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

/* renderer.js's toast(), as it is: the next id, pushed, drawn at once. */
function load() {
  const ctx = {
    console, timers: [], drawn: [], renders: 0,
    S: { toastId: 4, toasts: [] },
    esc: (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
  };
  ctx.setTimeout = (fn, ms) => { ctx.timers.push({ fn, ms }); return 0; };
  ctx.renderToasts = () => { ctx.renders++; };
  ctx.toast = (t, s, kind) => {
    const id = ++ctx.S.toastId;
    ctx.S.toasts.push({ id, t, s, kind });
    // What the window draws for it right now, through the hook.
    ctx.drawn.push(vm.runInContext("toastActionHTML", ctx)({ id, t, s, kind }));
  };
  vm.createContext(ctx);
  vm.runInContext(read("../renderer/toast-actions.js"), ctx, { filename: "toast-actions.js" });
  return ctx;
}

test("a toast with an action draws its button the moment it is drawn", () => {
  const c = load();
  let ran = 0;
  c.act = { label: "Open", run: () => { ran++; } };
  const id = vm.runInContext("toastWithAction('Background chat finished', '“T”', undefined, act)", c);
  assert.equal(id, 5);
  assert.equal(c.S.toasts.length, 1);
  assert.match(c.drawn[0], /<button class="btn btn-s sm toast-act" type="button" data-toastact="5">Open<\/button>/);
  assert.doesNotMatch(c.drawn[0], /data-act=/, "the window's own click handler never sees it");
  assert.equal(ran, 0);
});

test("pressing it: the toast goes, the action runs once", () => {
  const c = load();
  let ran = 0;
  c.act = { label: "Open", run: () => { ran++; } };
  vm.runInContext("toastWithAction('Done', '', undefined, act)", c);
  assert.equal(vm.runInContext("toastActionRun(5)", c), true);
  assert.equal(ran, 1);
  assert.equal(c.S.toasts.length, 0);
  assert.ok(c.renders > 0);
  assert.equal(vm.runInContext("toastActionRun(5)", c), false, "once");
  assert.equal(ran, 1);
});

test("without a usable action it is a plain toast; the label is escaped and short", () => {
  const c = load();
  assert.equal(vm.runInContext("toastWithAction('A', '', 'bad', null)", c), null);
  assert.equal(vm.runInContext("toastWithAction('B', '', 'bad', {label: '  ', run: () => {}})", c), null);
  assert.equal(c.S.toasts.length, 2);
  assert.deepEqual(c.drawn, ["", ""]);
  c.act = { label: "<b>" + "x".repeat(40), run: () => {} };
  vm.runInContext("toastWithAction('C', '', undefined, act)", c);
  assert.match(c.drawn[2], /&lt;b&gt;x{21}<\/button>/);
});

test("the action lives about as long as its toast", () => {
  const c = load();
  c.act = { label: "Open", run: () => {} };
  vm.runInContext("toastWithAction('Done', '', undefined, act)", c);
  const t = c.timers.find((x) => x.ms === 7000);
  assert.ok(t);
  t.fn();
  assert.equal(vm.runInContext("toastActionHTML({id: 5})", c), "");
});

test("renderer.js: toast() takes the next id, toastHTML has the hook inside the body; index.html loads the module first", () => {
  const src = read("../renderer/renderer.js");
  const fn = src.slice(src.indexOf("\nfunction toast(t, s, kind) {"), src.indexOf("\nfunction chatToast("));
  assert.match(fn, /const id = \+\+S\.toastId;\n\s*S\.toasts\.push\(\{id, t, s, kind\}\);\n\s*renderToasts\(\);/);
  const html = src.slice(src.indexOf("\nfunction toastHTML(t) {"), src.indexOf("\nfunction renderToasts("));
  assert.match(html, /\+ \(typeof toastActionHTML === 'function' \? toastActionHTML\(t\) : ''\) \+ '<\/span>'/);
  assert.ok(html.indexOf("toastActionHTML(t)") < html.indexOf("toast-x"), "under the text, before the cross");
  const page = read("../renderer/index.html");
  const at = page.indexOf('src="toast-actions.js"');
  assert.ok(at > 0 && at < page.indexOf('src="renderer.js"'));
  assert.match(read("../renderer/css/overlays.css"), /\.toast-acts\{/);
});
