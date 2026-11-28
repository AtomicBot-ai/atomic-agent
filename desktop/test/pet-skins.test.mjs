// ATO-2513: pets a person made, kept in userData (main/pet-skins.ts):
// every picture checked by its first bytes, a broken folder left out, the
// built-in atom whenever the chosen pet is gone.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../out/main/pet-skins.js");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 2)]);
const url = (mime, bytes) => `data:${mime};base64,${bytes.toString("base64")}`;
const frames = () => Object.fromEntries(S.PET_SKIN_FRAMES.map((f) => [f, url("image/png", PNG)]));

function dir(t) {
  const d = mkdtempSync(join(tmpdir(), "pet-skins-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

test("a picture is taken by its bytes, not by what the URL says", () => {
  assert.equal(S.petImageFromDataUrl(url("image/png", PNG)).ext, "png");
  assert.equal(S.petImageFromDataUrl(url("image/jpeg", JPEG)).ext, "jpg");
  assert.equal(S.petImageFromDataUrl(url("image/png", JPEG)), null, "a JPEG called a PNG");
  assert.equal(S.petImageFromDataUrl(url("image/png", Buffer.from("<svg onload=x>"))), null);
  assert.equal(S.petImageFromDataUrl("data:image/svg+xml;base64,PHN2Zz4="), null);
  assert.equal(S.petImageFromDataUrl("file:///etc/passwd"), null);
  assert.equal(S.petImageFromDataUrl(42), null);
});

test("seven states share four pictures", () => {
  assert.equal(S.petSkinFrame("thinking"), "working");
  assert.equal(S.petSkinFrame("working"), "working");
  assert.equal(S.petSkinFrame("error"), "waiting");
  assert.equal(S.petSkinFrame("waiting"), "waiting");
  assert.equal(S.petSkinFrame("sleeping"), "sleeping");
  assert.equal(S.petSkinFrame("done"), "idle");
  assert.equal(S.petSkinFrame("idle"), "idle");
});

test("save, list, read back and choose a made pet", (t) => {
  const d = dir(t);
  assert.deepEqual(S.listPetSkins(d), []);
  assert.equal(S.readSelectedPetSkin(d), S.PET_BUILT_IN, "the atom until one is chosen");
  const saved = S.savePetSkin(d, "0123456789abcdef", "  Space\ncat  ", frames(), 10);
  assert.equal(saved.ok, true);
  assert.equal(saved.skin.name, "Space cat");
  S.savePetSkin(d, "fedcba9876543210", "", frames(), 20);
  assert.deepEqual(S.listPetSkins(d).map((s) => [s.id, s.name]), [["fedcba9876543210", "My pet"], ["0123456789abcdef", "Space cat"]], "newest first");
  const imgs = S.readPetSkinImages(d, "0123456789abcdef");
  assert.equal(imgs.idle, url("image/png", PNG));
  assert.equal(S.writeSelectedPetSkin(d, "0123456789abcdef"), true);
  assert.equal(S.readSelectedPetSkin(d), "0123456789abcdef");
  rmSync(S.petSkinDir(d, "0123456789abcdef"), { recursive: true });
  assert.equal(S.readSelectedPetSkin(d), S.PET_BUILT_IN, "the chosen pet is gone: back to the atom");
});

test("a bad id, a missing picture or a path in pet.json is refused", (t) => {
  const d = dir(t);
  assert.equal(S.savePetSkin(d, "../../etc", "x", frames(), 0).ok, false);
  const partial = frames();
  delete partial.sleeping;
  assert.equal(S.savePetSkin(d, "0123456789abcdef", "x", partial, 0).ok, false);
  assert.deepEqual(S.listPetSkins(d), []);
  assert.equal(S.writeSelectedPetSkin(d, "../x"), false);
  // A hand-edited pet.json that points outside its folder is left out.
  const bad = join(d, S.PET_SKINS_DIR, "aaaaaaaaaaaaaaaa");
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "pet.json"), JSON.stringify({ name: "x", createdAt: 1, frames: { idle: "../../secret.png", working: "working.png", waiting: "waiting.png", sleeping: "sleeping.png" } }));
  assert.deepEqual(S.listPetSkins(d), []);
  assert.equal(S.readPetSkinImages(d, "aaaaaaaaaaaaaaaa"), null);
});

test("at most PET_SKINS_MAX pets", (t) => {
  const d = dir(t);
  for (let i = 0; i < S.PET_SKINS_MAX; i++) assert.equal(S.savePetSkin(d, i.toString(16).padStart(16, "0"), "p", frames(), i).ok, true);
  const over = S.savePetSkin(d, "ffffffffffffffff", "p", frames(), 99);
  assert.equal(over.ok, false);
  assert.match(over.error, /Delete one/);
});
