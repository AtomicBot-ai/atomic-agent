// ATO-687: the Flatpak manifest repackages the published .deb. bump.mjs keeps
// it on the newest release; these tests pin the manifest's shape it relies on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addRelease, bumpManifest, debName, parseSums } from "../flatpak/bump.mjs";

const manifest = readFileSync(new URL("../flatpak/io.atomicagent.desktop.yml", import.meta.url), "utf8");
const metainfo = readFileSync(new URL("../flatpak/io.atomicagent.desktop.metainfo.xml", import.meta.url), "utf8");
const desktopEntry = readFileSync(new URL("../flatpak/io.atomicagent.desktop.desktop", import.meta.url), "utf8");

test("app id is the bundle id everywhere", () => {
  assert.match(manifest, /^app-id: io\.atomicagent\.desktop$/m);
  assert.match(metainfo, /<id>io\.atomicagent\.desktop<\/id>/);
  assert.match(metainfo, /<launchable type="desktop-id">io\.atomicagent\.desktop\.desktop<\/launchable>/);
  assert.match(desktopEntry, /^Icon=io\.atomicagent\.desktop$/m);
  assert.match(desktopEntry, /^Exec=atomic-agent-desktop /m);
});

test("electron runs through zypak and the setuid sandbox helper is dropped", () => {
  assert.match(manifest, /^base: org\.electronjs\.Electron2\.BaseApp$/m);
  assert.match(manifest, /exec zypak-wrapper \/app\/atomic-agent\/atomic-agent-desktop "\$@"/);
  assert.match(manifest, /rm -f \/app\/atomic-agent\/chrome-sandbox/);
});

test("debName follows the release's file names", () => {
  assert.equal(debName("0.0.8", "x86_64"), "Atomic-Agent-0.0.8-amd64.deb");
  assert.equal(debName("0.0.8", "aarch64"), "Atomic-Agent-0.0.8-arm64.deb");
});

test("bumpManifest rewrites both arches' url and sha256 and nothing else", () => {
  const sums = parseSums(`${"a".repeat(64)}  Atomic-Agent-0.0.9-amd64.deb\n${"b".repeat(64)}  Atomic-Agent-0.0.9-arm64.deb\n`);
  const out = bumpManifest(manifest, "0.0.9", sums);
  assert.match(out, /only-arches: \[x86_64\][\s\S]*?url: \S+\/desktop-v0\.0\.9\/Atomic-Agent-0\.0\.9-amd64\.deb\n\s+sha256: a{64}/);
  assert.match(out, /only-arches: \[aarch64\][\s\S]*?url: \S+\/desktop-v0\.0\.9\/Atomic-Agent-0\.0\.9-arm64\.deb\n\s+sha256: b{64}/);
  assert.doesNotMatch(out, /desktop-v0\.0\.8/);
  const lines = (t) => t.split("\n").filter((l) => !/url: |sha256: /.test(l));
  assert.deepEqual(lines(out), lines(manifest));
});

test("bumpManifest refuses a release without one of the .debs", () => {
  const sums = parseSums(`${"a".repeat(64)}  Atomic-Agent-0.0.9-amd64.deb\n`);
  assert.throws(() => bumpManifest(manifest, "0.0.9", sums), /no Atomic-Agent-0\.0\.9-arm64\.deb/);
  assert.throws(() => bumpManifest(manifest, "v0.0.9", sums), /not a version/);
});

test("addRelease puts the new release first, once", () => {
  const once = addRelease(metainfo, "0.0.9", "2026-11-20");
  assert.ok(once.indexOf('version="0.0.9"') < once.indexOf('version="0.0.8"'));
  assert.equal(addRelease(once, "0.0.9", "2026-11-20"), once);
});
