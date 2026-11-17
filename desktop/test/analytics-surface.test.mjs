// ATO-1603: every event the desktop sends carries `surface: "desktop"`, the
// same property name the agent stamps on its own events (`tui` / `cli` /
// `desktop`, src/analytics/analytics-client.ts). The only way onto the wire
// is transport.enqueue in core.ts, and both of its callers spread
// globalProps() after the event's own props, so no event can drop or change
// it. Runs against the built output (npm run build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { EVENTS } = require("../out/main/analytics/catalog.js");
const { PostHogTransport } = require("../out/main/analytics/transport.js");

const mainDir = fileURLToPath(new URL("../main/", import.meta.url));
const core = readFileSync(join(mainDir, "analytics/core.ts"), "utf8");

function tsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [p] : [];
  });
}

test("globalProps stamps surface: desktop", () => {
  const body = core.slice(core.indexOf("export function globalProps()"));
  assert.match(body.slice(0, body.indexOf("\n}\n")), /surface: "desktop",/);
});

test("every enqueue spreads globalProps() last, so an event cannot override or drop surface", () => {
  const calls = core.match(/transport\.enqueue\([^;]*\);/g) ?? [];
  assert.equal(calls.length, 2, "track and trackFromRenderer");
  for (const call of calls) assert.match(call, /\{ \.\.\.v\.props, \.\.\.globalProps\(\) \}\)/);
});

test("nothing else in main/ puts analytics on the wire", () => {
  const others = tsFiles(mainDir).filter((p) => {
    if (p.endsWith(join("analytics", "core.ts")) || p.endsWith(join("analytics", "transport.ts"))) return false;
    const src = readFileSync(p, "utf8");
    return /new PostHogTransport\(|\btransport\.enqueue\(/.test(src);
  });
  assert.deepEqual(others, []);
});

test("every catalog event leaves with surface: desktop", async () => {
  const names = Object.keys(EVENTS);
  assert.ok(names.length > 20);
  const sent = [];
  const t = new PostHogTransport({
    canSend: () => true,
    distinctId: () => "id-1",
    fetchImpl: async (_url, init) => { sent.push(...JSON.parse(init.body).batch); return new Response("{}"); },
  });
  // What core.track / trackFromRenderer hand over: the event's own props
  // (here one that tries to blank the surface), then the global ones.
  const eventProps = { surface: null };
  for (const name of names) t.enqueue(name, { ...eventProps, ...{ surface: "desktop" } });
  await t.flush(5_000, Math.ceil(names.length / 100) + 1);
  assert.equal(sent.length, names.length);
  for (const e of sent) assert.equal(e.properties.surface, "desktop", e.event);
});
