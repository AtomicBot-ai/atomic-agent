// Settings › My files: the scans, photos and audio switch (ATO-2501).
// Run: npm run test:unit (the renderer helpers need no build)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { mfoSkipText, mfoWaitsForSwitch, mfoPagesText, MFO_TITLE, MFO_HELP } = require("../renderer/my-files-ocr.js");

test("every skip reason the agent writes reads as words, never the raw reason", () => {
  const cases = [
    ["scan: OCR not available (no OCR engine is set up for the file index)", /reading scans is off/],
    ["scan: OCR not available (no vision model is configured)", /no vision model is running/],
    ["scan: OCR not available (qwen-vl cannot read images)", /cannot read images/],
    ["scan: OCR failed (timeout)", /failed/],
    ["scan: OCR found no text", /no readable text/],
    ["disabled", /reading them is off/],
    ["no-vision-model: no vision provider configured", /no vision model/],
    ["no-engine: whisper-cli not found on PATH", /whisper\.cpp is not installed/],
    ['needs-model-download: speech model "base" (142 MB) is not downloaded yet', /not downloaded yet/],
    ["needs-ffmpeg: ffmpeg not found", /ffmpeg/],
    ["larger than 52428800 bytes", /Too large/],
    ["too-large: 300 bytes > 200", /Too large/],
    ["unsupported file type", /not supported/],
    ["no text in the file", /No text/],
    ["something new from a newer agent", /another reason/],
  ];
  for (const [reason, words] of cases) {
    const text = mfoSkipText(reason);
    assert.match(text, words, reason);
    assert.ok(!text.includes("scan:") && !text.includes("no-"), `raw reason leaked: ${text}`);
  }
});

test("only the reasons the switch clears count as waiting for it", () => {
  assert.equal(mfoWaitsForSwitch("scan: OCR not available (no OCR engine is set up for the file index)"), true);
  assert.equal(mfoWaitsForSwitch("disabled"), true);
  assert.equal(mfoWaitsForSwitch("scan: OCR not available (no vision model is configured)"), false);
  assert.equal(mfoWaitsForSwitch("no text in the file"), false);
});

test("pages read: none is no line", () => {
  assert.equal(mfoPagesText(0), "");
  assert.equal(mfoPagesText(undefined), "");
  assert.equal(mfoPagesText(1), "1 scanned page read");
  assert.equal(mfoPagesText(12), "12 scanned pages read");
});

test("the switch's words promise only what the agent does", () => {
  assert.match(MFO_HELP, /Cloud models are never used/);
  assert.match(MFO_HELP, /on this computer or your local network/, "the core also takes a model on the local network");
  assert.doesNotMatch(MFO_TITLE + MFO_HELP, /—|nothing leaves your machine/i);
});

test("the section is wired: script order, hook, act, config key, retry", () => {
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  const at = (name) => html.indexOf(`src="${name}"`);
  assert.ok(at("my-files.js") !== -1 && at("my-files.js") < at("my-files-ocr.js") && at("my-files-ocr.js") < at("renderer.js"));
  const screen = readFileSync(new URL("../renderer/my-files.js", import.meta.url), "utf8");
  assert.match(screen, /typeof mfOcrSectionHTML === 'function' \? mfOcrSectionHTML\(\) : ''/);
  assert.match(screen, /if \(verb === 'ocr' && typeof mfOcrToggle === 'function'\) \{ mfOcrToggle\(\); return; \}/);
  const ocr = readFileSync(new URL("../renderer/my-files-ocr.js", import.meta.url), "utf8");
  assert.match(ocr, /configPatchOr\(\{vision: \{indexFiles: next\}\}, \(\) => BR\.configSet\('vision\.indexFiles', String\(next\)\)\)/);
  assert.match(ocr, /act: 'myfiles:ocr'/);
  assert.match(ocr, /BR\.filesRetry\(\)/);
});
