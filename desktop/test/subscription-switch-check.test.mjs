// ATO-2463: switching the chat to a saved Claude Code / Codex provider asks
// the same live sign-in check as Add provider's step (ATO-1684) and, when the
// CLI says signed out, shows the same step (Sign in + the exact command).
// renderer/subscription-live-check.js, renderer/subscription-switch-check.js
// and renderer.js's wizard slice run in a vm. Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createContext, runInContext } from "node:vm";

const require = createRequire(import.meta.url);
const W = require("../renderer/subscription-switch-check.js");

const renderer = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const liveFile = readFileSync(new URL("../renderer/subscription-live-check.js", import.meta.url), "utf8");
const switchFile = readFileSync(new URL("../renderer/subscription-switch-check.js", import.meta.url), "utf8");
function slice(start, end) {
  const i = renderer.indexOf(start);
  assert.ok(i >= 0, start);
  const j = renderer.indexOf(end, i);
  assert.ok(j > i, end);
  return renderer.slice(i, j);
}
const tick = () => new Promise((r) => setTimeout(r, 0));

const SAVED = [
  { id: "claude-cli", kind: "subscription-cli", subscriptionCli: { cli: "claude" }, defaultChatModel: "opus" },
  { id: "codex-cli", kind: "subscription-cli", subscriptionCli: { cli: "codex" } },
  { id: "openrouter", kind: "openai-compatible" },
];

function load({ live, selectorOpen = true, platform = "MacIntel", active = "claude-cli" }) {
  const liveAsked = [];
  const toasts = [];
  const writes = [];
  const ctx = createContext({
    THIS_MACHINE: "this Mac",
    SEL: { open: selectorOpen, err: null },
    WIZ: { row: null, phase: null, forId: null },
    OB: { open: false },
    navigator: { platform },
    active,
    render() {},
    toast: (t, s, kind) => toasts.push({ t, s, kind }),
    selProviders: () => SAVED,
    BR: {
      providerKeyPresent: () => Promise.resolve({ ok: true, present: false }),
      subscriptionStatus: (cli) => Promise.resolve({ ok: true, status: { cli, installed: true, binPath: null, signedIn: true } }),
      subscriptionLiveCheck: (cli, force) => { liveAsked.push([cli, force]); return Promise.resolve({ ok: true, check: { cli, ...live } }); },
      upsertProvider: (e) => { writes.push(e); return Promise.resolve({ ok: true }); },
    },
  });
  runInContext("function selActiveProviderId() { return active; }\n"
    + liveFile + "\n" + switchFile + "\n" + slice("const KIND_ROWS = [", "];") + "];"
    + slice("function wizService(row)", "\n") + "\n"
    + slice("const WIZ_BILLING = new Map();", "async function wizSubscriptionStep(k)")
    + ";this.lines = wizSubscriptionLines; this.needsLogin = wizSubNeedsLogin; this.check = subSwitchCheck;"
    + " this.done = subSwitchSignedInDone; this.LIVE = SUB_LIVE; this.rows = KIND_ROWS;", ctx);
  return { ctx, liveAsked, toasts, writes };
}

test("a switch to a saved Claude Code with an expired login opens the Sign in step in the menu", async () => {
  const { ctx, liveAsked, toasts } = load({ live: { state: "signed_out", via: "auth_status", fix: "claude" } });
  ctx.check("claude-cli");
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(liveAsked)), [["claude", false]]);
  assert.equal(ctx.WIZ.phase, "configure");
  assert.equal(ctx.WIZ.row.subscriptionCli, "claude");
  assert.equal(ctx.WIZ.forId, "claude-cli", "the step edits the saved entry, not a new one");
  ctx.lines(ctx.WIZ.row); await tick();
  const lines = ctx.lines(ctx.WIZ.row);
  assert.ok(lines.some((l) => /but it is not signed in/.test(l.text)));
  assert.ok(lines.some((l) => l.code && l.copy && l.text === "claude"), "the exact command, with Copy");
  assert.equal(ctx.needsLogin(ctx.WIZ.row), true, "the main button is Sign in");
  assert.equal(toasts.length, 0);
});

test("the menu already closed: a toast with the exact command, PowerShell on Windows", async () => {
  const mac = load({ live: { state: "signed_out" }, selectorOpen: false });
  mac.ctx.check("claude-cli"); await tick();
  assert.equal(mac.ctx.WIZ.phase, null);
  assert.equal(mac.toasts.length, 1);
  assert.equal(mac.toasts[0].t, "Claude Code is not signed in");
  assert.match(mac.toasts[0].s, /^Run claude in Terminal and sign in with your Claude account/);
  assert.equal(mac.toasts[0].kind, "bad");
  const win = load({ live: { state: "signed_out" }, selectorOpen: false, platform: "Win32", active: "codex-cli" });
  win.ctx.check("codex-cli"); await tick();
  assert.match(win.toasts[0].s, /^Run codex login in PowerShell and sign in with your ChatGPT account/);
  for (const t of [...mac.toasts, ...win.toasts]) assert.doesNotMatch(t.t + t.s, /\u2014/);
});

test("signed in, a failed check, a missing CLI or another provider: nothing is shown", async () => {
  for (const state of ["signed_in", "failed", "missing"]) {
    const { ctx, toasts } = load({ live: { state } });
    ctx.check("claude-cli"); await tick();
    assert.equal(ctx.WIZ.phase, null, state);
    assert.equal(toasts.length, 0, state);
  }
  const other = load({ live: { state: "signed_out" }, active: "openrouter" });
  other.ctx.check("openrouter"); await tick();
  assert.equal(other.liveAsked.length, 0, "an API-key provider is not checked");
});

test("switched away before the answer: no hint for a provider no longer in use", async () => {
  const { ctx, toasts } = load({ live: { state: "signed_out" } });
  ctx.check("claude-cli");
  ctx.active = "openrouter";
  await tick();
  assert.equal(ctx.WIZ.phase, null);
  assert.equal(toasts.length, 0);
});

test("asked once per app session; an old signed-out answer is asked again", async () => {
  const { ctx, liveAsked, toasts } = load({ live: { state: "signed_out" }, selectorOpen: false });
  ctx.check("claude-cli"); await tick();
  ctx.check("claude-cli"); await tick();
  assert.equal(liveAsked.length, 1, "the second switch reads the kept answer");
  assert.equal(toasts.length, 2, "and still says it");
  ctx.LIVE.get("claude").askedAt = Date.now() - 60_000;
  ctx.check("claude-cli"); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(liveAsked[1])), ["claude", true]);
});

test("signed in from that step: it closes and the saved entry is not rewritten", async () => {
  const { ctx, toasts, writes } = load({ live: { state: "signed_out" } });
  ctx.check("claude-cli"); await tick();
  const row = ctx.WIZ.row;
  assert.equal(ctx.done(row), true);
  assert.equal(ctx.WIZ.phase, null);
  assert.equal(ctx.WIZ.forId, null);
  assert.equal(writes.length, 0);
  assert.equal(toasts[0].t, "Claude Code is signed in");
  // A plain Add provider step afterwards is not taken over.
  ctx.WIZ.row = row; ctx.WIZ.phase = "configure"; ctx.WIZ.forId = null;
  assert.equal(ctx.done(row), false);
});

test("pure parts: which CLI an entry runs and where the hint goes", () => {
  assert.equal(W.subSwitchCliOf({ subscriptionCli: { cli: "claude" } }), "claude");
  assert.equal(W.subSwitchCliOf({ subscriptionCli: "codex" }), "codex");
  assert.equal(W.subSwitchCliOf({ kind: "openai-compatible" }), null);
  assert.equal(W.subSwitchCliOf(null), null);
  const so = { state: "signed_out" };
  assert.equal(W.subSwitchWhere(so, { stillActive: true, selectorOpen: true, setupOpen: false }), "step");
  assert.equal(W.subSwitchWhere(so, { stillActive: true, selectorOpen: true, setupOpen: true }), "toast", "a setup the person has open is theirs");
  assert.equal(W.subSwitchWhere(so, { stillActive: true, selectorOpen: false }), "toast");
  assert.equal(W.subSwitchWhere(so, { stillActive: true, firstRun: true }), null);
  assert.equal(W.subSwitchWhere({ state: "signed_in" }, { stillActive: true, selectorOpen: true }), null);
});

test("hooks: the menu's provider and model rows, the step's end, and index.html", () => {
  const provider = slice("  if (row.type === 'provider') {\n    SEL.busy = true;", "  if (row.type === 'cloudModel') {");
  assert.match(provider, /if \(typeof subSwitchCheck === 'function'\) subSwitchCheck\(row\.id\);/);
  const model = slice("  if (row.type === 'cloudModel') {", "  if (row.type === 'localModel') {");
  assert.match(model, /bswReport\(res, 'Selected chat model ' \+ pid \+ '\/' \+ row\.id \+ '\.'\); if \(typeof subSwitchCheck === 'function'\) subSwitchCheck\(pid\);/);
  const step = slice("async function wizSubscriptionStep(k) {", "/* The model step's second pass");
  assert.match(step, /if \(typeof subSwitchSignedInDone === 'function' && subSwitchSignedInDone\(k\)\) return;/);
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  const at = html.indexOf('src="subscription-switch-check.js"');
  assert.ok(at > html.indexOf('src="subscription-live-check.js"') && at < html.indexOf('src="renderer.js"'));
});
