// ATO-733: main/workspace-busy.ts, against the built output (npm run build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { workspaceChangeBusy } = require("../out/main/workspace-busy.js");

const deps = (over) => ({ windowTurns: () => 0, agentTurns: async () => 0, timeoutMs: 1_000, ...over });

test("a turn the window streams holds the folder change back, without asking the agent", async () => {
  let asked = 0;
  const r = await workspaceChangeBusy(deps({ windowTurns: () => 1, agentTurns: async () => { asked++; return 0; } }));
  assert.deepEqual(r, { busy: true, elsewhere: false });
  assert.equal(asked, 0);
});

test("a turn only the agent runs (a scheduled task, a Telegram reply) holds it back too", async () => {
  assert.deepEqual(await workspaceChangeBusy(deps({ agentTurns: async () => 2 })), { busy: true, elsewhere: true });
});

test("a turn that began in a window chat while the agent was asked still counts", async () => {
  let n = 0;
  const r = await workspaceChangeBusy(deps({ windowTurns: () => n, agentTurns: async () => { n = 1; return 0; } }));
  assert.deepEqual(r, { busy: true, elsewhere: false });
});

test("an idle agent, one that cannot say, or one that does not answer in time lets the change through", async () => {
  assert.equal(await workspaceChangeBusy(deps({})), null);
  assert.equal(await workspaceChangeBusy(deps({ agentTurns: async () => null })), null);
  assert.equal(await workspaceChangeBusy(deps({ agentTurns: async () => { throw new Error("down"); } })), null);
  const t0 = Date.now();
  assert.equal(await workspaceChangeBusy(deps({ agentTurns: () => new Promise(() => {}), timeoutMs: 50 })), null);
  assert.ok(Date.now() - t0 < 1_000);
});
