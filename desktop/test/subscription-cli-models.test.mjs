// ATO-844: main's model list for a subscription-CLI provider, against the
// built output, and the copy of the agent's Claude list it keeps.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const m = require("../out/main/subscription-cli-models.js");

const core = readFileSync(new URL("../../src/llm/provider/subscription-cli/claude-cli-models.ts", import.meta.url), "utf8");
function coreList(name) {
  const at = core.indexOf("export const " + name);
  assert.ok(at >= 0, name);
  const body = core.slice(core.indexOf("[", at), core.indexOf("]", at));
  return [...body.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

test("the Claude list is the agent's, aliases first, and so is the default", () => {
  assert.deepEqual([...m.CLAUDE_CLI_CHAT_MODELS], [...coreList("CLAUDE_CLI_MODEL_ALIASES"), ...coreList("CLAUDE_CLI_MODEL_IDS")]);
  assert.match(core, new RegExp(`CLAUDE_CLI_DEFAULT_CHAT_MODEL = "${m.CLAUDE_CLI_DEFAULT_CHAT_MODEL}"`));
});

test("a Claude entry lists its pinned model first, then the built-in list, once each", () => {
  const ids = m.subscriptionCliModels({ id: "claude-cli", kind: "subscription-cli", defaultChatModel: "claude-opus-5", subscriptionCli: { cli: "claude" } });
  assert.equal(ids[0].id, "claude-opus-5");
  assert.equal(ids[0].provider, "claude-cli");
  assert.equal(new Set(ids.map((x) => x.id)).size, ids.length);
  assert.equal(ids.length, m.CLAUDE_CLI_CHAT_MODELS.length);
});

test("a Codex entry lists only what it pinned, and nothing when it pinned nothing", () => {
  assert.deepEqual(m.subscriptionCliModels({ id: "codex-cli", kind: "subscription-cli", subscriptionCli: { cli: "codex" } }), []);
  assert.deepEqual(m.subscriptionCliModels({ id: "codex-cli", kind: "subscription-cli", defaultChatModel: "gpt-5-codex", subscriptionCli: { cli: "codex" } }),
    [{ provider: "codex-cli", id: "gpt-5-codex" }]);
});

test("main answers a subscription provider's list before any agent call", () => {
  const src = readFileSync(new URL("../main/agent-cli.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export async function providerModels("));
  assert.ok(fn.indexOf("kind === SUBSCRIPTION_CLI_KIND") > 0);
  assert.ok(fn.indexOf("kind === SUBSCRIPTION_CLI_KIND") < fn.indexOf("cli(args"), "short-circuit comes before the models search");
});
