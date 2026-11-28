// ATO-2493: the paired-phone routes worded for Settings › Connect phone
// (main/phone-devices.ts, from the built output: npm run build first).
// The agent is a stub route: nothing leaves the process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const D = require("../out/main/phone-devices.js");

const answer = (status, body) => async () => ({ status, body });

test("a pairing: the QR link on the first LAN address, the short code, the other addresses as hints", async () => {
  const calls = [];
  const route = async (method, path) => { calls.push(`${method} ${path}`); return { status: 201, body: { path: "/pair/abc", code: "BCDF-GHJK", expiresAt: "2026-11-27T10:05:00.000Z" } }; };
  const out = await D.createPhonePairing(route, ["http://192.168.1.20:19193", "http://10.0.0.5:19193"]);
  assert.deepEqual(calls, ["POST /pairing"]);
  assert.deepEqual(out, {
    ok: true,
    url: "http://192.168.1.20:19193/pair/abc",
    code: "BCDF-GHJK",
    expiresAt: "2026-11-27T10:05:00.000Z",
    others: ["http://10.0.0.5:19193/panel"],
  });
});

test("an agent from before the short code still pairs by QR", async () => {
  const out = await D.createPhonePairing(answer(201, { path: "/pair/abc", expiresAt: "x" }), ["http://h:1"]);
  assert.equal(out.ok, true);
  assert.equal(out.code, null);
});

test("no network: no request, and words to connect to Wi-Fi", async () => {
  let called = false;
  const out = await D.createPhonePairing(async () => { called = true; return { status: 201, body: {} }; }, []);
  assert.equal(called, false);
  assert.equal(out.ok, false);
  assert.match(out.error, /Wi-Fi/);
});

test("an agent without the routes is unsupported, with an update hint, never its raw text", async () => {
  const out = await D.listPhoneDevices(answer(404, { error: { message: "No route for GET /api/devices" } }));
  assert.equal(out.ok, false);
  assert.equal(out.unsupported, true);
  assert.match(out.error, /newer agent/);
  const off = await D.createPhonePairing(answer(404, { error: { code: "pairing_off", message: "x" } }), ["http://h:1"]);
  assert.equal(off.unsupported, true);
});

test("a failure keeps the agent's words behind Details only", async () => {
  const out = await D.createPhonePairing(answer(500, { error: { message: "cannot read http-devices.json: EACCES" } }), ["http://h:1"]);
  assert.equal(out.ok, false);
  assert.doesNotMatch(out.error, /EACCES/);
  assert.match(out.detail, /EACCES/);
  const down = await D.listPhoneDevices(async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:19193"); });
  assert.equal(down.ok, false);
  assert.doesNotMatch(down.error, /ECONNREFUSED/);
  assert.match(down.detail, /ECONNREFUSED/);
});

test("the device list: only well-formed rows, the one seen last first", async () => {
  const out = await D.listPhoneDevices(answer(200, { devices: [
    { id: "aaaaaaaa", name: "iPhone", createdAt: "2026-11-01", lastSeenAt: "2026-11-02T00:00:00Z" },
    { id: "bbbbbbbb", name: "Android phone", createdAt: "2026-11-01", lastSeenAt: "2026-11-20T00:00:00Z" },
    { id: 3, name: "broken" },
  ] }));
  assert.equal(out.ok, true);
  assert.deepEqual(out.devices.map((d) => d.id), ["bbbbbbbb", "aaaaaaaa"]);
});

test("sign out: the id is checked first, and one already gone counts as done", async () => {
  const calls = [];
  const route = async (method, path) => { calls.push(`${method} ${path}`); return { status: 200, body: { revoked: ["aaaaaaaa"] } }; };
  assert.deepEqual(await D.revokePhoneDevice(route, "aaaaaaaa"), { ok: true });
  assert.deepEqual(calls, ["DELETE /aaaaaaaa"]);
  const bad = await D.revokePhoneDevice(route, "../all");
  assert.equal(bad.ok, false);
  assert.equal(calls.length, 1, "no request for an id that is not one");
  assert.deepEqual(await D.revokePhoneDevice(answer(404, { error: { code: "device_not_found" } }), "aaaaaaaa"), { ok: true });
});
