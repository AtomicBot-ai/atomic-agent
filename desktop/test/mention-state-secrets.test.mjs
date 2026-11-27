// Unit tests for main/mention-state-secrets.ts and the desktop @file fallback (ATO-2796),
// against the built output. Run: npm run build && npm run test:unit
// The chat's working folder is the agent's state folder: `@.env` and
// `@config.json` must be named, never inlined, as core does.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

// A fake state folder, set before main's modules read it at load time.
const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "mention-secrets-")));
process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
const SECRET = "OPENAI_API_KEY=sk-test-do-not-leak";
writeFileSync(join(stateDir, ".env"), `${SECRET}\n`);
writeFileSync(join(stateDir, "config.json"), JSON.stringify({ version: 1, note: "config-secret-marker" }));
mkdirSync(join(stateDir, "models"), { recursive: true });
writeFileSync(join(stateDir, "models", "llama-server.key"), "llama-key-marker\n");
writeFileSync(join(stateDir, "notes.md"), "plain notes\n");
after(() => rmSync(stateDir, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const F = require("../out/main/file-mentions.js");
const C = require("../out/main/mention-core.js");
const S = require("../out/main/mention-state-secrets.js");

test("@.env in the agent's state folder is named, not inlined", () => {
  const out = F.expandFileMentions("look at @.env", stateDir);
  assert.ok(!out.includes("sk-test-do-not-leak"), out);
  assert.match(out, /\.env \(0 B, not inlined: the agent's own settings file is never inlined\)/);
});

test("the fallback for an agent without the route keeps the keys out", async () => {
  // The agent has no /api/mentions/expand: main reads the file mentions itself.
  const tooOld = async () => null;
  const chat = [{ role: "user", content: "check @.env and @config.json and @models/llama-server.key and @notes.md" }];
  const out = await C.expandLastUserMessageViaCore(chat, stateDir, tooOld);
  const text = out[0].content;
  for (const marker of ["sk-test-do-not-leak", "config-secret-marker", "llama-key-marker"]) {
    assert.ok(!text.includes(marker), `${marker} leaked`);
  }
  assert.match(text, /plain notes/);
});

test("expandLastUserMessage itself refuses them by default", () => {
  const out = F.expandLastUserMessage([{ role: "user", content: "@.env" }], stateDir);
  assert.ok(!out[0].content.includes("sk-test-do-not-leak"));
});

test("the list is core's getStateSecretPaths, files only", () => {
  const names = S.stateSecretFiles("/s", "/s/models", "/h");
  assert.deepEqual(names, [
    "/s/config.json", "/s/.env", "/s/secrets-store.json", "/s/secret-sources.json",
    "/s/approval-rules.json", "/s/hooks.json", "/s/guard.md", "/s/plugins/plugins.json",
    "/s/plugins/marketplaces.json", "/h/.curlrc", "/h/.wgetrc", "/s/pr-autofix/state.json",
    "/s/models/llama-server.key", "/s/serve-api.key", "/s/model-share.key",
    "/s/models/core/chat.json", "/s/models/core/embedding.json", "/s/atomic-mail/session.json",
    "/s/http-devices.json",
  ].map((p) => join(p)));
});

test("Windows paths match without case", () => {
  const check = S.protectedPathCheck([join(stateDir, ".env")], "win32");
  assert.equal(check(join(stateDir, ".env").toUpperCase()), true);
  assert.equal(check(join(stateDir, "notes.md")), false);
});
