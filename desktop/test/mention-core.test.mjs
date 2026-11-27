// Unit tests for main/mention-core.ts (ATO-2472), against the built output.
// Run: npm run build && npm run test:unit
// The agent expands the last user message's mentions; an agent without the
// route still gets the plain file mentions read here.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../out/main/mention-core.js");

const dir = realpathSync(mkdtempSync(join(tmpdir(), "mention-core-")));
writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
after(() => rmSync(dir, { recursive: true, force: true }));

const chat = (last) => [{ role: "assistant", content: "hi @a.ts" }, { role: "user", content: last }];

test("the last user message goes to the agent and comes back expanded", async () => {
  const calls = [];
  const out = await C.expandLastUserMessageViaCore(chat("see @diff"), dir, async (text, folder) => {
    calls.push([text, folder]);
    return `${text}\n\n[expanded by the agent]`;
  });
  assert.deepEqual(calls, [["see @diff", dir]]);
  assert.equal(out[1].content, "see @diff\n\n[expanded by the agent]");
  assert.equal(out[0].content, "hi @a.ts");
});

test("an agent without the route gets the plain file mentions read in main", async () => {
  const out = await C.expandLastUserMessageViaCore(chat("explain @a.ts and @diff"), dir, async () => null);
  assert.match(out[1].content, /<file path="a\.ts">\nexport const a = 1;\n<\/file>/);
});

test("a failing call falls back the same way, and no folder or no @ asks nothing", async () => {
  const out = await C.expandLastUserMessageViaCore(chat("explain @a.ts"), dir, async () => { throw new Error("down"); });
  assert.match(out[1].content, /<file path="a\.ts">/);
  let asked = false;
  const ask = async () => { asked = true; return "x"; };
  await C.expandLastUserMessageViaCore(chat("no mention here"), dir, ask);
  await C.expandLastUserMessageViaCore(chat("see @diff"), null, ask);
  assert.equal(asked, false);
});
