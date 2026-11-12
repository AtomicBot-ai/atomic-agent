// ATO-1247: our own machines and test runs are tagged, not dropped: every
// event carries test_run: true and sets the person property atomic_team,
// so PostHog can leave them out without a hand-kept list of install ids.
// Runs against the built output (npm run build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const E = require("../out/main/analytics/environment.js");
const { PostHogTransport } = require("../out/main/analytics/transport.js");

test("teamRunIn: the env flag or ~/.atomic-agent-team", () => {
  const plain = mkdtempSync(join(tmpdir(), "team-"));
  const marked = mkdtempSync(join(tmpdir(), "team-"));
  writeFileSync(join(marked, ".atomic-agent-team"), "");
  assert.equal(E.teamRunIn({}, plain), false);
  assert.equal(E.teamRunIn({}, marked), true);
  assert.equal(E.teamRunIn({ ATOMIC_AGENT_TEAM: "1" }, plain), true);
  assert.equal(E.teamRunIn({ ATOMIC_AGENT_TEAM: "off" }, plain), false);
});

async function sent(team) {
  let body = null;
  const t = new PostHogTransport({
    canSend: () => true,
    distinctId: () => "id-1",
    team: () => team,
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return new Response("{}"); },
  });
  t.enqueue("app_opened", { surface: "desktop" });
  await t.flush();
  return body.batch[0].properties;
}

test("a team run's events are tagged on the event and the person", async () => {
  const p = await sent(true);
  assert.equal(p.test_run, true);
  assert.deepEqual(p.$set, { atomic_team: true });
  assert.equal(p.surface, "desktop");
});

test("everyone else's events are unchanged", async () => {
  const p = await sent(false);
  assert.equal("test_run" in p, false);
  assert.equal("$set" in p, false);
});
