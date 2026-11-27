// ATO-1684: the subscription step asks the CLI itself whether it is signed
// in, once per pick. main/subscription-cli-live-check.ts (against the built
// output), renderer/subscription-live-check.js, and renderer.js's wizard
// slice run in a vm with both. Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createContext, runInContext } from "node:vm";

const require = createRequire(import.meta.url);
const M = require("../out/main/subscription-cli-live-check.js");
const R = require("../renderer/subscription-live-check.js");

const ok = (stdout, code = 0, stderr = "") => ({ code, stdout, stderr, timedOut: false });
const step = (cli, via) => M.liveCheckSteps(cli).find((s) => s.via === via);

test("Codex is asked with `codex login status`, Claude with `claude auth status` and then one tiny turn", () => {
  assert.deepEqual(M.liveCheckSteps("codex").map((s) => s.args), [["login", "status"]]);
  const claude = M.liveCheckSteps("claude");
  assert.deepEqual(claude.map((s) => s.via), ["auth_status", "turn"]);
  assert.deepEqual(claude[0].args, ["auth", "status"]);
  const turn = claude[1].args;
  // One turn, the cheapest model, no tools, no MCP servers, no saved session.
  for (const [flag, value] of [["--max-turns", "1"], ["--model", "haiku"], ["--tools", ""], ["--output-format", "json"]]) {
    assert.equal(turn[turn.indexOf(flag) + 1], value, flag);
  }
  assert.ok(turn.includes("--strict-mcp-config") && turn.includes("--no-session-persistence"));
  for (const s of [...claude, ...M.liveCheckSteps("codex")]) assert.ok(s.timeoutMs > 0 && s.timeoutMs <= 30_000);
});

test("`claude auth status`: its JSON decides; an old CLI without it goes on to the turn", () => {
  const s = step("claude", "auth_status");
  assert.deepEqual(M.readStep("claude", s, ok('{"loggedIn": true, "authMethod": "claude.ai", "email": "n@x.io"}')), { state: "signed_in" });
  assert.deepEqual(M.readStep("claude", s, ok('{\n  "loggedIn": false\n}', 1)), { state: "signed_out" });
  assert.equal(M.readStep("claude", s, ok("", 1, "error: unknown command 'auth'")), "unsupported");
  assert.equal(M.readStep("claude", s, ok("", 1, "something else broke")), "unsupported");
  assert.deepEqual(M.readStep("claude", s, ok("", 1, "Not logged in. Please run /login")), { state: "signed_out" });
  assert.deepEqual(M.readStep("claude", s, { code: null, stdout: "", stderr: "", timedOut: false, spawnError: "ENOENT" }), { state: "missing" });
  assert.deepEqual(M.readStep("claude", s, { code: null, stdout: "", stderr: "", timedOut: true }), { state: "failed" });
  assert.deepEqual(M.readStep("claude", s, ok("", 1, "'claude' is not recognized as an internal or external command,")), { state: "missing" });
});

test("the tiny turn: answered is signed in, a login error is signed out, anything else is unknown", () => {
  const s = step("claude", "turn");
  assert.deepEqual(M.readStep("claude", s, ok('{"type":"result","is_error":false,"result":"ok"}')), { state: "signed_in" });
  assert.deepEqual(M.readStep("claude", s, ok('{"type":"result","is_error":true,"result":"Invalid API key · Please run /login"}', 1)), { state: "signed_out" });
  assert.deepEqual(M.readStep("claude", s, ok('{"type":"result","is_error":true,"error":"authentication_failed","result":"Failed to authenticate: OAuth session expired and could not be refreshed"}', 1)), { state: "signed_out" });
  assert.deepEqual(M.readStep("claude", s, ok('{"type":"result","is_error":true,"result":"Overloaded"}', 1)), { state: "failed" });
  assert.deepEqual(M.readStep("claude", s, ok("", 1, "error: unknown option '--tools'")), { state: "failed" });
});

test("`codex login status`: ChatGPT is signed in, an API key login is not the plan", () => {
  const s = step("codex", "auth_status");
  assert.deepEqual(M.readStep("codex", s, ok("Logged in using ChatGPT\n")), { state: "signed_in" });
  assert.deepEqual(M.readStep("codex", s, ok("Logged in using an API key - sk-proj-***abcd\n")), { state: "signed_out", apiKeyLogin: true });
  assert.deepEqual(M.readStep("codex", s, ok("", 1, "Not logged in\n")), { state: "signed_out" });
  assert.deepEqual(M.readStep("codex", s, ok("", 1, "panic: something")), { state: "failed" });
});

test("a Claude Code with `auth status` never spends a turn; one without it spends exactly one", async () => {
  const ran = [];
  const now = () => 1000;
  const modern = await M.runLiveCheck("claude", async (s) => { ran.push(s.via); return ok('{"loggedIn": true, "email": "n@x.io"}'); }, now);
  assert.deepEqual(ran, ["auth_status"]);
  assert.deepEqual(modern, { cli: "claude", state: "signed_in", via: "auth_status", fix: null, checkedAt: 1000 });
  assert.doesNotMatch(JSON.stringify(modern), /n@x\.io/, "nothing the CLI printed comes back");

  ran.length = 0;
  const old = await M.runLiveCheck("claude", async (s) => {
    ran.push(s.via);
    return s.via === "auth_status" ? ok("", 1, "error: unknown command 'auth'") : ok('{"type":"result","is_error":true,"result":"Please run /login"}', 1);
  }, now);
  assert.deepEqual(ran, ["auth_status", "turn"]);
  assert.equal(old.state, "signed_out");
  assert.equal(old.via, "turn");
  assert.equal(old.fix, "claude");

  const codex = await M.runLiveCheck("codex", async () => ok("Logged in using an API key - sk-xyz"), now);
  assert.deepEqual(codex, { cli: "codex", state: "signed_out", via: "auth_status", fix: "codex login", apiKeyLogin: true, checkedAt: 1000 });
  assert.doesNotMatch(JSON.stringify(codex), /sk-xyz/);

  const thrown = await M.runLiveCheck("codex", async () => { throw new Error("boom"); }, now);
  assert.equal(thrown.state, "failed");
});

test("the cache: one run per CLI per session; Check again reruns, but not twice within the gap", async () => {
  let t = 0;
  let runs = 0;
  let release;
  const cache = new M.LiveCheckCache(async (cli) => {
    runs++;
    await new Promise((r) => { release = r; });
    return { cli, state: "signed_in", via: "auth_status", fix: null, checkedAt: t };
  }, () => t);
  const a = cache.get("claude");
  const b = cache.get("claude", true);
  release();
  assert.equal(await a, await b, "a second ask shares the running check");
  assert.equal(runs, 1);
  await cache.get("claude");
  assert.equal(runs, 1, "picking the row again does not run it again");
  t = M.LIVE_CHECK_MIN_GAP_MS - 1;
  await cache.get("claude", true);
  assert.equal(runs, 1, "a forced ask inside the gap gets the last answer");
  t = M.LIVE_CHECK_MIN_GAP_MS + 1;
  const forced = cache.get("claude", true);
  release();
  await forced;
  assert.equal(runs, 2);
  const codex = cache.get("codex");
  release();
  await codex;
  assert.equal(runs, 3, "each CLI has its own answer");
});

test("the merge: the CLI's own answer wins over the login file, an unknown never blocks", () => {
  const file = { cli: "claude", installed: true, binPath: null, signedIn: true };
  assert.equal(R.subLiveMerge(file, undefined), file);
  assert.equal(R.subLiveMerge({ installed: false, signedIn: false }, { checking: false, check: { state: "signed_in" } }).signedIn, false);
  assert.equal(R.subLiveMerge(file, { checking: false, check: { state: "signed_out" } }).signedIn, false);
  assert.equal(R.subLiveMerge({ ...file, signedIn: false }, { checking: false, check: { state: "signed_in" } }).signedIn, true);
  const failed = R.subLiveMerge(file, { checking: false, check: { state: "failed" } });
  assert.equal(failed.signedIn, true);
  assert.equal(failed.liveFailed, true);
  const missing = R.subLiveMerge(file, { checking: false, check: { state: "missing" } });
  assert.equal(missing.installed, true, "the check not finding it does not undo the file's find");
  assert.equal(R.subLiveMerge(file, { checking: true, check: null }).checking, true);
  assert.match(R.subLiveLine({ installed: true, checking: true }, "Claude Code", "claude").text, /^Checking that Claude Code is signed in/);
  assert.match(R.subLiveLine({ installed: true, liveFailed: true }, "Codex", "codex").text, /You can go on.*codex login/);
  assert.equal(R.subLiveLine({ installed: true, signedIn: true, liveChecked: true }, "Codex", "codex"), null);
  for (const l of [R.subLiveLine({ installed: true, checking: true }, "Codex", "codex"), R.subLiveLine({ installed: true, liveFailed: true }, "Codex", "codex")]) {
    assert.doesNotMatch(l.text, /\u2014/);
  }
});

const renderer = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const liveFile = readFileSync(new URL("../renderer/subscription-live-check.js", import.meta.url), "utf8");
function slice(start, end) {
  const i = renderer.indexOf(start);
  assert.ok(i >= 0, start);
  const j = renderer.indexOf(end, i);
  assert.ok(j > i, end);
  return renderer.slice(i, j);
}

function loadWizard(fileStatus, liveAnswer) {
  const liveAsked = [];
  const ctx = createContext({
    THIS_MACHINE: "this Mac",
    WIZ: { row: null },
    OB: { open: false },
    navigator: { platform: "MacIntel" },
    render() {},
    BR: {
      providerKeyPresent: () => Promise.resolve({ ok: true, present: false }),
      subscriptionStatus: (cli) => Promise.resolve({ ok: true, status: { cli, ...fileStatus } }),
      subscriptionLiveCheck: (cli, force) => { liveAsked.push([cli, force]); return Promise.resolve({ ok: true, check: { cli, ...liveAnswer } }); },
    },
  });
  runInContext(liveFile + "\n" + slice("const KIND_ROWS = [", "];") + "];"
    + slice("function wizService(row)", "\n") + "\n"
    + slice("const WIZ_BILLING = new Map();", "async function wizSubscriptionStep(k)")
    + ";this.rows = KIND_ROWS; this.lines = wizSubscriptionLines; this.needsLogin = wizSubNeedsLogin; this.recheck = wizSubRecheck;", ctx);
  return { ctx, liveAsked };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("picking Claude Code with a login file but a dead login shows Sign in right away", async () => {
  const { ctx, liveAsked } = loadWizard({ installed: true, binPath: null, signedIn: true }, { state: "signed_out", via: "auth_status", fix: "claude" });
  const claude = ctx.rows[3];
  ctx.WIZ.row = claude;
  ctx.lines(claude); await tick();
  const checking = ctx.lines(claude);
  assert.ok(checking.some((l) => /^Checking that Claude Code is signed in/.test(l.text)), "a checking line while the CLI answers");
  assert.equal(ctx.needsLogin(claude), false, "nothing changes before the answer");
  await tick();
  ctx.lines(claude); ctx.lines(claude);
  assert.equal(ctx.needsLogin(claude), true);
  assert.ok(ctx.lines(claude).some((l) => /but it is not signed in/.test(l.text)));
  assert.equal(liveAsked.length, 1, "asked once, however often the step is drawn");
  ctx.recheck(claude); ctx.lines(claude); await tick(); ctx.lines(claude);
  assert.deepEqual(JSON.parse(JSON.stringify(liveAsked)), [["claude", false], ["claude", true]], "Check again asks again");
});

test("a CLI the login file says is missing is not run", async () => {
  const { ctx, liveAsked } = loadWizard({ installed: false, binPath: null, signedIn: false }, { state: "signed_in" });
  const codex = ctx.rows[4];
  ctx.WIZ.row = codex;
  ctx.lines(codex); await tick(); ctx.lines(codex); await tick();
  assert.equal(liveAsked.length, 0);
});

test("the sign-in poll does not move on while the CLI still says signed out", () => {
  const src = slice("function wizSubPollTick()", "/** Copy:");
  assert.match(src, /st\.signedIn === true && !\(typeof subLiveHoldsSignedOut === 'function' && subLiveHoldsSignedOut\(cli\)\)/);
  R.SUB_LIVE.clear();
  assert.equal(R.subLiveHoldsSignedOut("claude"), false, "no live answer: the file decides, as before");
  R.SUB_LIVE.set("claude", { checking: false, check: { state: "signed_out" }, askedAt: Date.now() });
  assert.equal(R.subLiveHoldsSignedOut("claude"), true);
  R.SUB_LIVE.set("claude", { checking: false, check: { state: "signed_in" }, askedAt: Date.now() });
  assert.equal(R.subLiveHoldsSignedOut("claude"), false);
  R.SUB_LIVE.clear();
});
