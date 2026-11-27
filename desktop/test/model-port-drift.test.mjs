// ATO-1750: main/model-port-drift.ts, against the built output (npm run build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const D = require("../out/main/model-port-drift.js");

const managed = (port) => ({ localModels: { mode: "managed", managed: { port } } });

test("a loopback address gives its port; any other address none", () => {
  assert.equal(D.loopbackPort("http://127.0.0.1:19091"), 19091);
  assert.equal(D.loopbackPort("http://localhost:19092/"), 19092);
  assert.equal(D.loopbackPort("http://[::1]:8080"), 8080);
  assert.equal(D.loopbackPort("http://192.168.1.5:19091"), null);
  assert.equal(D.loopbackPort("https://127.0.0.1:19091"), null);
  assert.equal(D.loopbackPort("not a url"), null);
  assert.equal(D.loopbackPort(null), null);
});

test("only managed mode names a port to follow; no port written is the agent's default", () => {
  assert.equal(D.managedPortIn(managed(19100)), 19100);
  assert.equal(D.managedPortIn({ localModels: { mode: "managed", managed: {} } }), 19091);
  assert.equal(D.managedPortIn({ localModels: { mode: "external", url: "http://127.0.0.1:9931" } }), null);
  assert.equal(D.managedPortIn(null), null);
});

test("the agent is behind when its address names another port than the file", () => {
  assert.deepEqual(D.stalePortMove("http://127.0.0.1:19091", managed(19093)), { from: 19091, to: 19093 });
  assert.equal(D.stalePortMove("http://127.0.0.1:19091", managed(19091)), null);
  assert.equal(D.stalePortMove(undefined, managed(19093)), null);
  assert.equal(D.stalePortMove("http://127.0.0.1:19091", { localModels: { mode: "external" } }), null);
});

function harness({ state = "connected", remote = false, llamaUrl = "http://127.0.0.1:19091", config = managed(19093) } = {}) {
  let started = null;
  const restarts = [];
  const said = [];
  const undo = D.wireModelPortDrift({
    onModelStarted: (fn) => { started = fn; return () => { started = null; }; },
    agent: () => ({ state, remote, llamaUrl }),
    readConfig: () => config,
    restart: () => { restarts.push(1); return Promise.resolve(); },
    say: (line) => said.push(line),
  });
  return { fire: () => started?.(), restarts, said, undo };
}

test("a start on a new port restarts the connected agent once, and says so", () => {
  const h = harness();
  h.fire();
  assert.equal(h.restarts.length, 1);
  assert.equal(h.said.length, 1);
  assert.match(h.said[0], /19093/);
  assert.match(h.said[0], /19091/);
});

test("nothing restarts when the agent is already on the port, still starting, remote, or the route is external", () => {
  for (const opts of [
    { config: managed(19091) },
    { state: "starting" },
    { remote: true },
    { config: { localModels: { mode: "external", url: "http://127.0.0.1:9931" } } },
    { llamaUrl: null },
  ]) {
    const h = harness(opts);
    h.fire();
    assert.equal(h.restarts.length, 0, JSON.stringify(opts));
  }
});

test("the undo stops the watch", () => {
  const h = harness();
  h.undo();
  h.fire();
  assert.equal(h.restarts.length, 0);
});
