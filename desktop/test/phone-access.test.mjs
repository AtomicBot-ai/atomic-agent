// ATO-2493: Settings › Connect phone's "Allow phones on this Wi-Fi"
// (main/phone-access.ts, from the built output: npm run build first).
// Off by default; on, serve listens on 0.0.0.0 on a fixed port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../out/main/phone-access.js");

function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "phone-access-"));
  return { dir, path: P.phoneAccessPath(dir) };
}

test("off when there is no file or it is broken; on only after it is saved on", () => {
  const { dir, path } = tempPath();
  try {
    assert.equal(P.readPhoneAccess(path), false);
    writeFileSync(path, "{not json");
    assert.equal(P.readPhoneAccess(path), false);
    P.writePhoneAccess(true, path);
    assert.equal(P.readPhoneAccess(path), true);
    P.writePhoneAccess(false, path);
    assert.equal(P.readPhoneAccess(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loopback while off, every interface while on", () => {
  assert.equal(P.serveHostFor(false), "127.0.0.1");
  assert.equal(P.serveHostFor(true), "0.0.0.0");
});

test("on takes the fixed port when it is free, and a free port otherwise; off never asks for it", async () => {
  const free = async () => 50123;
  let asked = 0;
  assert.equal(await P.servePortFor(true, free, async (p) => { asked = p; return true; }), P.PHONE_PORT);
  assert.equal(asked, P.PHONE_PORT);
  assert.equal(await P.servePortFor(true, free, async () => false), 50123);
  asked = 0;
  assert.equal(await P.servePortFor(false, free, async (p) => { asked = p; return true; }), 50123);
  assert.equal(asked, 0);
});

test("LAN addresses: Wi-Fi first, never loopback, link-local, VPN or container addresses", () => {
  const v4 = (address, internal = false) => ({ address, family: "IPv4", internal, netmask: "255.255.255.0", mac: "", cidr: null });
  const out = P.lanAddresses({
    lo0: [v4("127.0.0.1", true)],
    utun3: [v4("100.64.0.2")],
    bridge100: [v4("192.168.64.1")],
    docker0: [v4("172.17.0.1")],
    "Local Area Connection": [v4("10.0.0.5")],
    en0: [v4("192.168.1.20"), { address: "fe80::1", family: "IPv6", internal: false, netmask: "", mac: "", cidr: null }],
    en7: [v4("169.254.10.2")],
  });
  assert.deepEqual(out, ["192.168.1.20", "10.0.0.5"]);
});
