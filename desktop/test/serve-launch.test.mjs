// Unit tests for main/serve-launch.ts (ATO-1705), against the built output:
// the agent's API key goes in its environment, never on its command line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const L = require("../out/main/serve-launch.js");

test("serve's arguments carry no key", () => {
  const args = L.serveSpawnArgs(51234, []);
  assert.deepEqual(args, ["serve", "--host", "127.0.0.1", "--port", "51234"]);
  assert.ok(!args.includes("--api-key"));
});

test("the platform's watch arguments come last", () => {
  assert.deepEqual(L.serveSpawnArgs(5000, ["--parent-pid", "77"]), [
    "serve", "--host", "127.0.0.1", "--port", "5000", "--parent-pid", "77",
  ]);
});

test("ATO-2493: the host is loopback unless one is given (phones on this Wi-Fi)", () => {
  assert.deepEqual(L.serveSpawnArgs(19193, [], "0.0.0.0"), ["serve", "--host", "0.0.0.0", "--port", "19193"]);
  assert.equal(L.serveSpawnArgs(5000, [])[2], "127.0.0.1");
});

test("the key is in the child environment under ATOMIC_AGENT_API_KEY", () => {
  const base = { PATH: "/usr/bin", ATOMIC_AGENT_STATE_DIR: "/state" };
  const env = L.serveSpawnEnv(base, "0f1e2d3c4b5a69788796a5b4c3d2e1f0");
  assert.equal(L.SERVE_API_KEY_ENV, "ATOMIC_AGENT_API_KEY");
  assert.equal(env.ATOMIC_AGENT_API_KEY, "0f1e2d3c4b5a69788796a5b4c3d2e1f0");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.ATOMIC_AGENT_STATE_DIR, "/state");
  assert.equal(base.ATOMIC_AGENT_API_KEY, undefined, "the base environment is not changed");
});

test("the per-launch key wins over one inherited from the desktop's own environment", () => {
  const env = L.serveSpawnEnv({ ATOMIC_AGENT_API_KEY: "inherited-key-123" }, "fresh-key-0123456789");
  assert.equal(env.ATOMIC_AGENT_API_KEY, "fresh-key-0123456789");
});
