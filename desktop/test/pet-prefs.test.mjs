// ATO-2391: the desktop pet's settings (main/pet-prefs.ts): off by default,
// pet.json in userData (never the agent's config), validated on read and
// on change, and a window spot that stays on a display.
// Run: npm run build && npm run test:unit
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PET_DEFAULTS, PET_FILE, PET_MARGIN, PET_SIZE, mergePetPrefs, parsePetPrefs, petBounds, readPetPrefs, writePetPrefs } = require("../out/main/pet-prefs.js");

const dir = mkdtempSync(join(tmpdir(), "pet-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("off by default: no file, a broken file, a wrong shape", () => {
  assert.deepEqual(PET_DEFAULTS, { enabled: false, dnd: false, x: null, y: null });
  assert.deepEqual(readPetPrefs(join(dir, "none")), PET_DEFAULTS);
  writeFileSync(join(dir, PET_FILE), "{not json");
  assert.deepEqual(readPetPrefs(dir), PET_DEFAULTS);
  assert.deepEqual(parsePetPrefs([1, 2]), PET_DEFAULTS);
  assert.deepEqual(parsePetPrefs({ enabled: "yes", dnd: 1 }), PET_DEFAULTS, "only a real true turns it on");
});

test("a position is two finite numbers or none", () => {
  assert.deepEqual(parsePetPrefs({ enabled: true, x: 10.4, y: 20.6 }), { enabled: true, dnd: false, x: 10, y: 21 });
  assert.deepEqual(parsePetPrefs({ x: 10 }), PET_DEFAULTS);
  assert.deepEqual(parsePetPrefs({ x: Infinity, y: 1 }), PET_DEFAULTS);
  assert.deepEqual(parsePetPrefs({ x: 1e9, y: 1 }), PET_DEFAULTS);
});

test("written and read back whole", () => {
  const prefs = { enabled: true, dnd: true, x: 100, y: 200 };
  assert.equal(writePetPrefs(dir, prefs), true);
  assert.deepEqual(readPetPrefs(dir), prefs);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, PET_FILE), "utf8")), prefs);
});

test("a change takes known keys with good values only", () => {
  const cur = { enabled: false, dnd: false, x: 5, y: 6 };
  assert.deepEqual(mergePetPrefs(cur, { enabled: true }), { ...cur, enabled: true });
  assert.deepEqual(mergePetPrefs(cur, { dnd: "on", evil: 1 }), cur);
  assert.deepEqual(mergePetPrefs(cur, { x: 50, y: 60 }), { ...cur, x: 50, y: 60 });
  assert.deepEqual(mergePetPrefs(cur, { x: "a", y: 60 }), cur, "half a position changes nothing");
  assert.deepEqual(mergePetPrefs(cur, { x: null, y: null }), { ...cur, x: null, y: null });
});

const primary = { workArea: { x: 0, y: 25, width: 1440, height: 875 } };
const second = { workArea: { x: 1440, y: 0, width: 1920, height: 1080 } };

test("first time: the bottom right corner of the primary work area", () => {
  const b = petBounds(PET_DEFAULTS, [primary], primary);
  assert.deepEqual(b, {
    x: 1440 - PET_SIZE.width - PET_MARGIN,
    y: 25 + 875 - PET_SIZE.height - PET_MARGIN,
    width: PET_SIZE.width,
    height: PET_SIZE.height,
  });
});

test("a saved spot on a display is kept, moved inside its work area", () => {
  const on = petBounds({ ...PET_DEFAULTS, x: 1600, y: 300 }, [primary, second], primary);
  assert.equal(on.x, 1600);
  assert.equal(on.y, 300);
  const edge = petBounds({ ...PET_DEFAULTS, x: 1440 + 1920 - 200, y: 0 }, [primary, second], primary);
  assert.equal(edge.x, 1440 + 1920 - PET_SIZE.width, "pushed back inside");
});

test("a saved spot whose display is gone falls back to the corner", () => {
  const gone = petBounds({ ...PET_DEFAULTS, x: 5000, y: 300 }, [primary], primary);
  assert.equal(gone.x, 1440 - PET_SIZE.width - PET_MARGIN);
});
