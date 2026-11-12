// Unit tests for main/quant-fit.ts (ATO-450), against the built output.
// Run: npm run build && npm run test:unit
// Every Hugging Face quant gets a fit badge, a speed estimate on Apple
// Silicon, and the best one for this machine leads the list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { appleChipBandwidth, formatSpeedEstimate, quantBitsFromName, quantFitFor, quantMachine, rateRepoChoices } =
  require("../out/main/quant-fit.js");

const GB = 1_000_000_000;
const choice = (path, gb) => ({ path, filename: path, sizeBytes: gb * GB, fileSizeGb: gb, sizeLabel: `${gb} GB` });
const repo = (choices) => ({ repoId: "unsloth/Qwen3.5-9B-GGUF", revision: "main", choices, mmproj: null, hidden: null });

test("reads the Apple chip; nothing off a Mac", () => {
  assert.equal(appleChipBandwidth("Apple M2 Pro"), 200);
  assert.equal(appleChipBandwidth("Apple M9 Max"), 300);
  assert.equal(quantMachine("darwin", 32 * GB, "Apple M2 Pro").unifiedGbPerSec, 200);
  assert.deepEqual(quantMachine("win32", 32 * GB, "AMD Ryzen 9"), { ramGb: 32, gpuBudgetGb: null, unifiedGbPerSec: null });
});

test("bit level and fit", () => {
  assert.equal(quantBitsFromName("Qwen3.5-9B-UD-Q4_K_XL.gguf"), 4);
  assert.equal(quantBitsFromName("model.gguf"), null);
  const mac = quantMachine("darwin", 32 * GB, "Apple M2 Pro");
  assert.equal(quantFitFor(6, mac).label, "Fits well");
  assert.equal(quantFitFor(26, mac).label, "Tight fit");
  assert.equal(quantFitFor(40, mac).label, "Too big");
});

test("the estimate always says it is one", () => {
  assert.equal(formatSpeedEstimate(24), "~25 tok/s, estimate");
  assert.equal(formatSpeedEstimate(0.5), "under 1 tok/s, estimate");
});

test("leads with the most precise quant that fits and answers at 20 tok/s or more", () => {
  const mac = quantMachine("darwin", 32 * GB, "Apple M2 Pro");
  const rated = rateRepoChoices(repo([
    choice("Qwen3.5-9B-UD-Q4_K_XL.gguf", 5.6),
    choice("Qwen3.5-9B-Q3_K_M.gguf", 4.4),
    choice("Qwen3.5-9B-Q5_K_M.gguf", 6.5),
    choice("Qwen3.5-9B-Q8_0.gguf", 9.5),
  ]), mac);
  assert.deepEqual(rated.choices.map((c) => c.path), [
    "Qwen3.5-9B-UD-Q4_K_XL.gguf",
    "Qwen3.5-9B-Q3_K_M.gguf",
    "Qwen3.5-9B-Q5_K_M.gguf",
    "Qwen3.5-9B-Q8_0.gguf",
  ]);
  assert.equal(rated.choices[0].recommended, true);
  assert.match(rated.choices[0].speed.label, /^~\d+ tok\/s, estimate$/);
});

test("off a Mac: fit by RAM, no speed, never a 3-bit pick", () => {
  const pc = quantMachine("linux", 16 * GB, "Intel");
  const rated = rateRepoChoices(repo([choice("m-Q3_K_M.gguf", 4.4), choice("m-Q4_K_M.gguf", 5.6)]), pc);
  assert.equal(rated.choices[0].path, "m-Q4_K_M.gguf");
  assert.ok(rated.choices.every((c) => c.speed === null));
});

test("a single named file is rated but not marked", () => {
  const mac = quantMachine("darwin", 32 * GB, "Apple M2 Pro");
  const rated = rateRepoChoices(repo([choice("m-Q4_K_M.gguf", 5.6)]), mac);
  assert.equal(rated.choices[0].recommended, false);
  assert.equal(rated.choices[0].fit.label, "Fits well");
});
