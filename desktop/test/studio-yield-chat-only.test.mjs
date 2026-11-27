// ATO-2461: Studio's pause of the local chat model (main/daemon-watch.ts
// yieldChatToStudio / resumeChatAfterStudio), against the built output.
// Run: npm run build && npm run test:unit
// The pause stops only the chat model (`models stop --chat-only`, as the Cloud
// switch and the TUI's stopChatForCloudSelection do): the small embedding model
// stays, so memory search keeps working while Studio generates. It is not a
// stop on purpose. When Studio is done the chat model comes back with one
// `models start`, which finds the embedding model already running: no second
// embedding start, no stop of anything.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const home = mkdtempSync(join(tmpdir(), "studio-yield-"));
process.env.ATOMIC_AGENT_STATE_DIR = home;
after(() => rmSync(home, { recursive: true, force: true }));
// Unref'd timers in the code under test must not let node:test see an empty loop (ATO-1255).
let keepAlive;
before(() => { keepAlive = setInterval(() => {}, 60_000); });
after(() => clearInterval(keepAlive));

const CONFIG = {
  localModels: { mode: "managed", managed: { modelId: "qwen-test" }, embeddings: { enabled: true, modelId: "embed-test" } },
};
writeFileSync(join(home, "config.json"), JSON.stringify(CONFIG));

const require = createRequire(import.meta.url);
const { withCliStandIn } = require("../out/main/agent-cli.js");
const { bringUpInFlight } = require("../out/main/backend-switch.js");
const { yieldChatToStudio, resumeChatAfterStudio } = require("../out/main/daemon-watch.js");

const UP = "mode:           managed\ndaemon:         running (pid 4242)  http://127.0.0.1:19091\nhealth:         ok\n";
const DOWN = "mode:           managed\ndaemon:         stopped  http://127.0.0.1:19091\nhealth:         down\n";

/** A stand-in agent: the chat server up until a stop, then down until a start. */
function agent({ stopOut }) {
  const calls = [];
  const told = [];
  let chatUp = true;
  const standIn = async (args) => {
    calls.push(args.join(" "));
    const verb = args.slice(0, 2).join(" ");
    if (verb === "models status") return { ok: true, stdout: chatUp ? UP : DOWN, stderr: "" };
    if (verb === "models stop") { chatUp = false; return { ok: true, stdout: stopOut, stderr: "" }; }
    if (verb === "models start") {
      chatUp = true;
      return { ok: true, stdout: "chat: started pid 4343, healthy on port 19091\nembedding: already running pid 4141 on port 19092 (embed-test)\n", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };
  const hooks = { tell: (e) => told.push(e), configHint: () => CONFIG, daemonPidAlive: () => chatUp };
  return { calls, told, run: (body) => withCliStandIn(standIn, body, hooks) };
}

test("the yield stops only the chat model, not as a stop on purpose; the resume starts the chat model once", async () => {
  const a = agent({ stopOut: "stopped chat model; embedding model kept for memory search\n" });
  await a.run(async () => {
    const y = await yieldChatToStudio();
    assert.equal(y.stopped, true);
    const stops = a.calls.filter((c) => c.startsWith("models stop"));
    assert.deepEqual(stops, ["models stop --chat-only"], "only a chat-only stop, never a full `models stop`");
    assert.ok(!a.told.includes("stopping"), "Studio's pause is not a stop on purpose");

    resumeChatAfterStudio(y);
    await (bringUpInFlight() ?? Promise.resolve());
  });
  const starts = a.calls.filter((c) => c.startsWith("models start"));
  assert.deepEqual(starts, ["models start --interactive"], "the chat model comes back; the embedding one is not started a second time");
  assert.deepEqual(a.calls.filter((c) => c.startsWith("models stop")), ["models stop --chat-only"], "nothing more is stopped");
});

test("an agent without --chat-only stops both: still a pause, and the resume's start brings both back", async () => {
  const a = agent({ stopOut: "stopped\n" });
  await a.run(async () => {
    const y = await yieldChatToStudio();
    assert.equal(y.stopped, true);
    assert.ok(!a.told.includes("stopping"));
    resumeChatAfterStudio(y);
    await (bringUpInFlight() ?? Promise.resolve());
  });
  assert.equal(a.calls.filter((c) => c.startsWith("models start --interactive")).length, 1);
});
