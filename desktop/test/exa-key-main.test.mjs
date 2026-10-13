// Unit tests for ATO-328 (main/agent-cli.ts), against the built output.
// Run: npm run build && npm run test:unit
//
// The Exa key typed in the window goes to <stateDir>/.env as EXA_API_KEY,
// through the same `app:dotenvSet` writer the Telegram bot token uses: the
// agent reads that file into its environment when it starts, and web search
// reads `web.search.exa.apiKeyEnv` (EXA_API_KEY) from there. Tested here: the
// guard the IPC handler applies before it writes, and the write itself. Every
// key is a dummy in a throwaway state dir.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const posix = process.platform !== "win32";
const home = mkdtempSync(join(tmpdir(), "ato328-home-"));
process.env.ATOMIC_AGENT_STATE_DIR = home;
const cli = createRequire(import.meta.url)("../out/main/agent-cli.js");

const dirs = [home];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function freshDir() {
  const d = mkdtempSync(join(tmpdir(), "ato328-"));
  dirs.push(d);
  return d;
}
const KEY = "exa-dummy-0123456789abcdef";

test("the window may write EXA_API_KEY and TELEGRAM_BOT_TOKEN to .env, and no other name", () => {
  assert.deepEqual([...cli.DESKTOP_DOTENV_KEYS], ["TELEGRAM_BOT_TOKEN", "EXA_API_KEY"]);
  assert.equal(cli.desktopDotenvError("EXA_API_KEY", KEY), null);
  assert.equal(cli.desktopDotenvError("EXA_API_KEY", null), null, "null removes the key");
  assert.equal(cli.desktopDotenvError("TELEGRAM_BOT_TOKEN", "123:abc"), null);
  for (const name of ["OPENAI_API_KEY", "PATH", "BRAVE_SEARCH_API_KEY", "exa_api_key", "", undefined, 1]) {
    assert.match(String(cli.desktopDotenvError(name, KEY)), /may be written from the desktop/, String(name));
  }
  assert.equal(cli.desktopDotenvError("EXA_API_KEY", 42), "value must be a string or null");
});

test("an Exa key that is not one line of printable characters is refused, and never quoted back", () => {
  for (const bad of [KEY + "\nPATH=/tmp/evil", "two words here", "short", "", "k".repeat(257), KEY + "\u0000"]) {
    const err = cli.desktopDotenvError("EXA_API_KEY", bad);
    assert.equal(err, "That does not look like an Exa API key.", JSON.stringify(bad));
  }
  assert.equal(cli.exaKeyValueError(KEY), null);
  assert.equal(cli.exaKeyValueError("k".repeat(256)), null);
});

test("the key lands in .env as EXA_API_KEY, owner-only, other keys and comments kept", { skip: !posix }, () => {
  const dir = freshDir();
  const env = join(dir, ".env");
  writeFileSync(env, "# mine\nTELEGRAM_BOT_TOKEN=123:abc\n", { mode: 0o644 });
  const res = cli.dotenvSet(dir, "EXA_API_KEY", KEY);
  assert.equal(res.ok, true, res.error);
  assert.equal(readFileSync(env, "utf8"), `# mine\nTELEGRAM_BOT_TOKEN=123:abc\nEXA_API_KEY=${KEY}\n`);
  assert.equal(statSync(env).mode & 0o777, 0o600);
  assert.deepEqual(cli.dotenvKeys(dir).keys, ["TELEGRAM_BOT_TOKEN", "EXA_API_KEY"]);
  // A second save replaces it in place.
  cli.dotenvSet(dir, "EXA_API_KEY", KEY + "2");
  assert.equal(readFileSync(env, "utf8"), `# mine\nTELEGRAM_BOT_TOKEN=123:abc\nEXA_API_KEY=${KEY}2\n`);
  // Removing it (null) keeps the rest.
  cli.dotenvSet(dir, "EXA_API_KEY", null);
  assert.equal(readFileSync(env, "utf8"), "# mine\nTELEGRAM_BOT_TOKEN=123:abc\n");
});

test("a fresh state dir gets a .env holding only the key", { skip: !posix }, () => {
  const dir = freshDir();
  const res = cli.dotenvSet(dir, "EXA_API_KEY", KEY);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.preexisting, false);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), `EXA_API_KEY=${KEY}\n`);
  assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);
  assert.equal(existsSync(join(dir, `.env.tmp-${process.pid}`)), false);
});
