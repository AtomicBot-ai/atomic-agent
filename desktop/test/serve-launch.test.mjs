// Unit tests for main/serve-launch.ts (ATO-1705, ATO-2538), against the built output:
// the agent's API key goes to it on stdin, never on its command line or in its environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const L = require("../out/main/serve-launch.js");

test("serve's arguments carry no key, and ask for it on stdin", () => {
  const args = L.serveSpawnArgs(51234, []);
  assert.deepEqual(args, ["serve", "--host", "127.0.0.1", "--port", "51234", "--api-key-stdin"]);
  assert.ok(!args.includes("--api-key"));
});

test("the platform's watch arguments come last", () => {
  assert.deepEqual(L.serveSpawnArgs(5000, ["--parent-pid", "77"]), [
    "serve", "--host", "127.0.0.1", "--port", "5000", "--api-key-stdin", "--parent-pid", "77",
  ]);
});

test("the child environment has no ATOMIC_AGENT_API_KEY, even one the desktop inherited", () => {
  const base = { PATH: "/usr/bin", ATOMIC_AGENT_STATE_DIR: "/state", ATOMIC_AGENT_API_KEY: "inherited-key-123" };
  const env = L.serveSpawnEnv(base);
  assert.equal(L.SERVE_API_KEY_ENV, "ATOMIC_AGENT_API_KEY");
  assert.equal(env.ATOMIC_AGENT_API_KEY, undefined);
  assert.ok(!("ATOMIC_AGENT_API_KEY" in env));
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.ATOMIC_AGENT_STATE_DIR, "/state");
  assert.equal(base.ATOMIC_AGENT_API_KEY, "inherited-key-123", "the base environment is not changed");
});

/* The bypass of ATO-2538, end to end: a child started the way agent-client.ts
   starts serve reports its own environment and argv (what `/proc/<pid>/environ`
   and `ps eww` would show) and the first line of its stdin. */
test("a child started this way gets the key on stdin and has it nowhere else", async () => {
  const token = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
  const script = [
    "let data = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (c) => { data += c; });",
    "process.stdin.on('end', () => {",
    "  const envHasKey = Object.values(process.env).some((v) => typeof v === 'string' && v.includes(" + JSON.stringify(token) + "));",
    "  process.stdout.write(JSON.stringify({ envVar: process.env.ATOMIC_AGENT_API_KEY ?? null, envHasKey, argv: process.argv, line: data.split('\\n')[0], rest: data.split('\\n').slice(1).join('') }));",
    "});",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", script, "--", ...L.serveSpawnArgs(5000, [])], {
    ...L.serveSpawnOptions({ ...process.env, ATOMIC_AGENT_API_KEY: "inherited-key-123" }),
  });
  L.sendServeKey(child.stdin, token);
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0);
  const seen = JSON.parse(out);
  assert.equal(seen.line, token, "the key arrives as the first line of stdin");
  assert.equal(seen.rest, "", "nothing follows the key, and the pipe is closed");
  assert.equal(seen.envVar, null, "no ATOMIC_AGENT_API_KEY in the child environment");
  assert.equal(seen.envHasKey, false, "the key is in no variable at all");
  assert.ok(!seen.argv.some((a) => a.includes(token)), "the key is on no command line");
});

test("the spawn options: no key in the env, stdin piped for it, no console window", () => {
  const opts = L.serveSpawnOptions({ PATH: "/usr/bin", ATOMIC_AGENT_API_KEY: "inherited-key-123" });
  assert.deepEqual(Object.keys(opts).sort(), ["env", "stdio", "windowsHide"]);
  assert.ok(!("ATOMIC_AGENT_API_KEY" in opts.env));
  assert.equal(opts.env.PATH, "/usr/bin");
  assert.deepEqual(opts.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(opts.windowsHide, true);
});

/* Review F2014.1: the test above only holds if agent-client.ts spawns serve
   with these same options. Its spawn takes them whole and sets no env or
   stdio of its own, and no key variable is named anywhere in that file. */
test("agent-client.ts spawns serve with serveSpawnOptions and adds no env or stdio", () => {
  const src = readFileSync(new URL("../main/agent-client.ts", import.meta.url), "utf8");
  const start = src.indexOf("child = spawn(");
  const end = src.indexOf("sendServeKey(child.stdin, token);", start);
  assert.ok(start >= 0 && end > start, "the serve spawn and the key hand-off are found");
  const call = src.slice(start, end);
  assert.match(call, /\.\.\.serveSpawnOptions\(agentEnv\(\)\)/);
  assert.doesNotMatch(call, /\benv\s*:/, "no env of its own");
  assert.doesNotMatch(call, /\bstdio\s*:/, "no stdio of its own");
  assert.doesNotMatch(src, /ATOMIC_AGENT_API_KEY|SERVE_API_KEY_ENV/);
});

test("sending the key to a child without stdin, or one already gone, does not throw", async () => {
  L.sendServeKey(null, "k");
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: L.SERVE_STDIO, windowsHide: true });
  await new Promise((resolve) => child.on("exit", resolve));
  assert.doesNotThrow(() => L.sendServeKey(child.stdin, "late-key"));
});
