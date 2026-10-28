// ATO-756: is the Claude Code / Codex CLI installed and signed in, read from
// files only. Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { detectSubscriptionCli, isSubscriptionCli } = require("../out/main/subscription-cli-detect.js");

/** A fake disk: `files` maps a path to its text (or "" for any file). */
function host(files, env = {}, platform = "darwin") {
  const read = [];
  return {
    read,
    deps: {
      platform,
      env,
      home: platform === "win32" ? "C:\\Users\\nadia" : "/Users/nadia",
      exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
      readText: (p) => { read.push(p); return Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null; },
    },
  };
}

test("missing everywhere: not installed, not signed in", () => {
  const { deps } = host({}, { PATH: "/usr/bin:/bin" });
  assert.deepEqual({ ...detectSubscriptionCli("claude", deps) }, { cli: "claude", installed: false, binPath: null, signedIn: false });
});

test("on PATH: installed, nothing to pin; the oauthAccount record means signed in", () => {
  const { deps } = host({
    "/opt/homebrew/bin/claude": "",
    "/Users/nadia/.claude.json": JSON.stringify({ oauthAccount: { emailAddress: "x@y.z" }, userID: "u" }),
  }, { PATH: "/usr/bin:/opt/homebrew/bin" });
  const st = detectSubscriptionCli("claude", deps);
  assert.equal(st.installed, true);
  assert.equal(st.binPath, null);
  assert.equal(st.signedIn, true);
  assert.ok(!JSON.stringify(st).includes("x@y.z"), "never hands back account details");
});

test("a Dock-opened app's short PATH: the native installer's ~/.local/bin is found and pinned", () => {
  const { deps } = host({ "/Users/nadia/.local/bin/claude": "", "/Users/nadia/.claude/.credentials.json": "{}" }, { PATH: "/usr/bin:/bin" });
  const st = detectSubscriptionCli("claude", deps);
  assert.equal(st.installed, true);
  assert.equal(st.binPath, "/Users/nadia/.local/bin/claude");
  assert.equal(st.signedIn, true);
});

test("Claude installed but ~/.claude.json has no account: signed out; unreadable: unknown", () => {
  const out = host({ "/usr/local/bin/claude": "", "/Users/nadia/.claude.json": "{\"numStartups\":3}" }, { PATH: "/usr/local/bin" });
  assert.equal(detectSubscriptionCli("claude", out.deps).signedIn, false);
  const bad = host({ "/usr/local/bin/claude": "", "/Users/nadia/.claude.json": "{not json" }, { PATH: "/usr/local/bin" });
  assert.equal(detectSubscriptionCli("claude", bad.deps).signedIn, null);
});

test("Codex: ChatGPT tokens are a subscription login; an API key alone is not", () => {
  const chatgpt = host({ "/usr/local/bin/codex": "", "/Users/nadia/.codex/auth.json": JSON.stringify({ tokens: { id_token: "secret" } }) }, { PATH: "/usr/local/bin" });
  const st = detectSubscriptionCli("codex", chatgpt.deps);
  assert.equal(st.signedIn, true);
  assert.ok(!JSON.stringify(st).includes("secret"));
  const key = host({ "/usr/local/bin/codex": "", "/srv/codex/auth.json": JSON.stringify({ OPENAI_API_KEY: "sk-x" }) }, { PATH: "/usr/local/bin", CODEX_HOME: "/srv/codex" });
  assert.deepEqual({ ...detectSubscriptionCli("codex", key.deps) }, { cli: "codex", installed: true, binPath: null, signedIn: false, apiKeyLogin: true });
});

test("Windows: the npm .cmd shim under %APPDATA%\\npm is found off PATH", () => {
  const { deps } = host({ "C:\\Users\\nadia\\AppData\\Roaming\\npm\\codex.cmd": "" }, { Path: "C:\\Windows\\system32", APPDATA: "C:\\Users\\nadia\\AppData\\Roaming" }, "win32");
  const st = detectSubscriptionCli("codex", deps);
  assert.equal(st.installed, true);
  assert.equal(st.binPath, "C:\\Users\\nadia\\AppData\\Roaming\\npm\\codex.cmd");
});

test("only claude and codex are asked about", () => {
  assert.equal(isSubscriptionCli("claude"), true);
  assert.equal(isSubscriptionCli("codex"), true);
  assert.equal(isSubscriptionCli("bash"), false);
});
