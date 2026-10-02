// Unit tests for main/local-llama-key.ts, against the built output.
// Run: npm run build && npm run test:unit
// Which key the desktop sends to a local llama-server (#582): the env key,
// else the managed daemon's key file for its own loopback port, else none.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { pickLocalLlamaKey, isLoopbackOnPort } = require("../out/main/local-llama-key.js");

const withKey = mkdtempSync(join(tmpdir(), "llama-key-"));
writeFileSync(join(withKey, "llama-server.key"), "abc123\n");
const withoutKey = mkdtempSync(join(tmpdir(), "llama-key-none-"));
after(() => {
  rmSync(withKey, { recursive: true, force: true });
  rmSync(withoutKey, { recursive: true, force: true });
});

const PORTS = [19191, 19192];

test("the managed port on loopback gets the key from the models dir", () => {
  for (const url of ["http://127.0.0.1:19191", "http://localhost:19191/", "http://[::1]:19192"]) {
    assert.equal(pickLocalLlamaKey({ url, envKey: null, managedPorts: PORTS, dataDir: withKey }), "abc123", url);
  }
});

test("no key file means no key, as before the agent started writing one", () => {
  assert.equal(
    pickLocalLlamaKey({ url: "http://127.0.0.1:19191", envKey: null, managedPorts: PORTS, dataDir: withoutKey }),
    null,
  );
});

test("an external server never gets the managed key", () => {
  for (const url of ["http://127.0.0.1:8080", "http://192.168.1.5:19191", "https://llm.example.com"]) {
    assert.equal(pickLocalLlamaKey({ url, envKey: null, managedPorts: PORTS, dataDir: withKey }), null, url);
  }
});

test("the env key wins everywhere, external servers included", () => {
  for (const url of ["http://127.0.0.1:19191", "http://127.0.0.1:8080", "https://llm.example.com"]) {
    assert.equal(pickLocalLlamaKey({ url, envKey: "from-env", managedPorts: PORTS, dataDir: withKey }), "from-env", url);
  }
});

test("a key file with spaces or commas is not sent", () => {
  const bad = mkdtempSync(join(tmpdir(), "llama-key-bad-"));
  try {
    writeFileSync(join(bad, "llama-server.key"), "a,b\n");
    assert.equal(pickLocalLlamaKey({ url: "http://127.0.0.1:19191", envKey: null, managedPorts: PORTS, dataDir: bad }), null);
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
});

test("loopback check needs both a loopback host and a managed port", () => {
  assert.equal(isLoopbackOnPort("http://127.0.0.1:19191", PORTS), true);
  assert.equal(isLoopbackOnPort("http://127.0.0.1", PORTS), false);
  assert.equal(isLoopbackOnPort("not a url", PORTS), false);
});
