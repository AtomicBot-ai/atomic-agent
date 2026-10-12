// Unit tests for main/tui-import.ts's database arm, against the built output.
// Run: npm run build && npm run test:unit
// The import replaces sessions.sqlite / memory.sqlite with the agent down. A
// stop that let go of an agent still there after its SIGKILL answers false,
// and then nothing is replaced under it.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

// Both directories are throwaway ones, named before the module reads them:
// the terminal agent's is $HOME/.atomic-agent, the desktop's
// ATOMIC_AGENT_STATE_DIR. node --test runs this file in a process of its own.
const home = mkdtempSync(join(tmpdir(), "tui-import-home-"));
const desktopState = mkdtempSync(join(tmpdir(), "tui-import-desktop-"));
process.env.HOME = home;
process.env.USERPROFILE = home; // os.homedir() on Windows
process.env.ATOMIC_AGENT_STATE_DIR = desktopState;
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(desktopState, { recursive: true, force: true });
});
mkdirSync(join(home, ".atomic-agent"));
writeFileSync(join(home, ".atomic-agent", "config.json"), "{}");

const require = createRequire(import.meta.url);
const { importFromTui, IMPORT_AGENT_STILL_RUNNING } = require("../out/main/tui-import.js");
const { withCliStandIn } = require("../out/main/agent-cli.js");

const sessions = join(desktopState, "sessions.sqlite");
const stage = () => {
  writeFileSync(sessions, "the running agent's sessions");
  writeFileSync(sessions + "-wal", "its live write-ahead log");
};

test("a database import refuses when the agent's stop could not end it, and touches nothing", async () => {
  stage();
  const calls = [];
  const res = await importFromTui({ sessions: true, memory: true }, {
    stopAgent: async () => { calls.push("stop"); return false; },
    startAgent: async () => { calls.push("start"); },
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, IMPORT_AGENT_STILL_RUNNING);
  // The app gets its agent back, and the files the old one holds are as they were.
  assert.deepEqual(calls, ["stop", "start"]);
  assert.equal(readFileSync(sessions, "utf8"), "the running agent's sessions");
  assert.equal(existsSync(sessions + "-wal"), true);
});

test("with the agent gone, the database arm runs and the agent is started again", async () => {
  stage();
  const calls = [];
  // The terminal agent has no sessions.sqlite here, so nothing is copied — but the arm ran: the -wal is gone.
  const res = await importFromTui({ sessions: true }, {
    stopAgent: async () => { calls.push("stop"); return true; },
    startAgent: async () => { calls.push("start"); },
  });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(calls, ["stop", "start"]);
  assert.equal(existsSync(sessions + "-wal"), false);
});

test("provider import migrates old cloud entries without resetting desktop choices or current-format inherit", async () => {
  for (const version of [74, 75, 76, undefined]) {
    const source = {
      llm: { providers: [
        { id: "new-cloud", kind: "openrouter", modelModes: { exact: "local" } },
        { id: "new-local", kind: "llama-server" },
        { id: "manual", kind: "gemini", modelMode: "local" },
        { id: "existing", kind: "openrouter" },
        { id: "inherit", kind: "openrouter" },
      ] },
    };
    if (version !== undefined) source.version = version;
    const sourceText = JSON.stringify(source);
    const sourcePath = join(home, ".atomic-agent", "config.json");
    writeFileSync(sourcePath, sourceText);
    let config = { version: 75, llm: { activeTextProvider: "local-llama", providers: [
      { id: "local-llama", kind: "llama-server" },
      { id: "existing", kind: "openrouter", modelMode: "local", modelModes: { exact: "cloud" } },
      { id: "inherit", kind: "openrouter" },
    ] } };
    const result = await withCliStandIn(async (args, input) => {
      if (args.join(" ") === "config get") return { ok: true, stdout: JSON.stringify(config), stderr: "" };
      assert.deepEqual(args, ["config", "set", "-"]);
      config = JSON.parse(input);
      return { ok: true, stdout: "", stderr: "" };
    }, () => importFromTui({ providers: true }));
    assert.equal(result.ok, true, result.error);
    const entry = (id) => config.llm.providers.find((p) => p.id === id);
    assert.equal(entry("new-cloud").modelMode, version === 74 ? "cloud" : undefined);
    assert.deepEqual(entry("new-cloud").modelModes, { exact: "local" });
    assert.equal(entry("new-local").modelMode, undefined);
    assert.equal(entry("manual").modelMode, "local");
    assert.equal(entry("existing").modelMode, "local");
    assert.deepEqual(entry("existing").modelModes, { exact: "cloud" });
    assert.equal(entry("inherit").modelMode, undefined);
    assert.equal(config.llm.activeTextProvider, "local-llama");
    assert.equal(readFileSync(sourcePath, "utf8"), sourceText, "the terminal config stays read-only");
  }
});
