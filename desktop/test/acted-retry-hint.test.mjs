// ATO-862 / ATO-900: under the last reply of a turn that acted, a muted retry
// icon explains why there is no "Ask again". Its sentence is a CSS tooltip
// (data-tip, drawn by chat.css on hover), not a native title: the native one
// waits for the pointer to rest on the same node, and the renders that land
// right after a turn ends replace that node, so in a real build it never
// came up. Clicks stay inert.
//
// renderer.js and chat.css are read as text; msgActs runs in a vm context
// with its neighbours stubbed. No deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const chatCss = readFileSync(new URL("../renderer/css/chat.css", import.meta.url), "utf8");

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

function msgActsFor({ acted }) {
  const c = vm.createContext({
    S: { streamId: null, busy: false },
    esc: (s) => String(s),
    ic: (n) => "<svg data-ic=\"" + n + "\"></svg>",
    isLastReply: () => true,
    replyRetryAsk: () => (acted ? null : { id: "u1" }),
    replyTurnActed: () => acted,
  });
  vm.runInContext(constLine("ACTED_RETRY_HINT") + fn("msgActs") + "globalThis.msgActs = msgActs;", c);
  return c.msgActs({ id: "a1", k: "assistant", text: "done" });
}

test("a turn that acted draws the muted hint with its sentence in data-tip and no native title", () => {
  const html = msgActsFor({ acted: true });
  const hint = html.match(/<button[^>]*msgact-off[^>]*>/);
  assert.ok(hint, html);
  const tag = hint[0];
  assert.match(tag, /data-tip="Repeating this turn could create or delete files a second time"/);
  assert.match(tag, /aria-label="Repeating this turn could create or delete files a second time"/);
  assert.doesNotMatch(tag, /\stitle=/, "a native title too would show the sentence twice");
  // Inert: no handler hook, skipped by Tab, disabled for assistive tech.
  assert.doesNotMatch(tag, /data-resend|data-act/);
  assert.match(tag, /aria-disabled="true"/);
  assert.match(tag, /tabindex="-1"/);
});

test("a turn without tools keeps Ask again with its native title", () => {
  const html = msgActsFor({ acted: false });
  assert.match(html, /data-resend="u1" title="Ask again"/);
  assert.doesNotMatch(html, /msgact-off/);
});

test("chat.css draws the hint's tooltip on hover, unfaded, and lets clicks through", () => {
  const after = chatCss.match(/\.msgact-off\[data-tip\]::after\{([^}]*)\}/);
  assert.ok(after, "the ::after rule exists");
  assert.match(after[1], /content:attr\(data-tip\)/);
  assert.match(after[1], /opacity:0/);
  assert.match(after[1], /pointer-events:none/);
  const hover = chatCss.match(/\.msgact-off\[data-tip\]:hover::after\{([^}]*)\}/);
  assert.ok(hover, "the hover rule exists");
  assert.match(hover[1], /opacity:1/);
  // The fade is on the icon: an opacity on the button would fade its tooltip too.
  const off = chatCss.match(/\.msgact\.msgact-off,\.msgact\.msgact-off:hover\{([^}]*)\}/);
  assert.ok(off);
  assert.doesNotMatch(off[1], /opacity/);
  assert.match(off[1], /position:relative/);
  assert.match(chatCss, /\.msgact\.msgact-off svg\{opacity:\.55\}/);
});
