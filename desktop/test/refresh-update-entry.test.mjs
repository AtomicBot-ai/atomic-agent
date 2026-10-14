// ATO-369: stapling the DMG after electron-builder wrote stable-mac.yml left
// the DMG entry with a stale size and sha512 (scripts/refresh-update-entry.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileDigest, refreshUpdateEntry } from "../scripts/refresh-update-entry.mjs";

const feed = () => ({
  version: "0.0.2",
  files: [
    { url: "Atomic-Agent-0.0.2-arm64-mac.zip", sha512: "ZIP", size: 100 },
    { url: "Atomic-Agent-0.0.2-arm64.dmg", sha512: "OLD", size: 200 },
  ],
  path: "Atomic-Agent-0.0.2-arm64-mac.zip",
  sha512: "ZIP",
  releaseDate: new Date("2026-10-13T20:06:58.917Z"),
});

test("the DMG entry gets the new size and sha512, the zip and legacy path stay", () => {
  const info = refreshUpdateEntry(feed(), "Atomic-Agent-0.0.2-arm64.dmg", { size: 205, sha512: "NEW" });
  assert.deepEqual(info.files[1], { url: "Atomic-Agent-0.0.2-arm64.dmg", sha512: "NEW", size: 205 });
  assert.deepEqual(info.files[0], { url: "Atomic-Agent-0.0.2-arm64-mac.zip", sha512: "ZIP", size: 100 });
  assert.equal(info.path, "Atomic-Agent-0.0.2-arm64-mac.zip");
  assert.equal(info.sha512, "ZIP");
  assert.equal(info.releaseDate, "2026-10-13T20:06:58.917Z");
});

test("the legacy top-level sha512 follows when path names the file", () => {
  const info = refreshUpdateEntry(feed(), "Atomic-Agent-0.0.2-arm64-mac.zip", { size: 101, sha512: "ZIP2" });
  assert.equal(info.sha512, "ZIP2");
  assert.equal(info.files[0].sha512, "ZIP2");
});

test("a file that is not listed is an error, not a silent no-op", () => {
  assert.throws(() => refreshUpdateEntry(feed(), "Other.dmg", { size: 1, sha512: "x" }), /not in files/);
});

test("sha512 is the base64 SHA-512 of the bytes, as electron-updater checks it", () => {
  assert.deepEqual(fileDigest(Buffer.alloc(0)), {
    size: 0,
    sha512: "z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==",
  });
});
