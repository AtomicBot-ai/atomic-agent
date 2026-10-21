// Unit tests for main/studio-catalog.ts, against the built output.
// Run: npm run build && npm run test:unit
// The Images and Video forms are built from one model shape, whether the model is
// OpenRouter's (Core's /media/providers/openrouter/models) or a local diffusion family.
// Fixtures are trimmed copies of conf's providers/media.json and models/diffusion.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeProviderModels, normalizeCloudModel, normalizeLocalFamilies, contentFlags } = require("../out/main/studio-catalog.js");
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/studio/${name}`, import.meta.url), "utf8"));

test("cloud image models keep what the form needs, default first", () => {
  const section = normalizeProviderModels(fixture("core-media-models-image.json"), "image");
  assert.equal(section.provider, "openrouter");
  assert.equal(section.live, false);
  assert.equal(section.error.code, "REMOTE_NOT_CONFIGURED");
  const [banana, gpt] = section.models;
  assert.equal(banana.id, "google/gemini-nano-banana-2.1");
  assert.equal(banana.default, true);
  assert.deepEqual(banana.modes, ["create", "edit", "reference"]);
  assert.equal(banana.aspectRatios.default, "1:1");
  assert.deepEqual(banana.resolutions.values, ["1K", "2K", "4K"]);
  assert.equal(banana.maxInputImages, 14);
  assert.equal(banana.maxCount, 1);
  assert.equal(gpt.maxCount, 4);
  assert.deepEqual(gpt.background.values, ["auto", "transparent", "opaque"]);
  assert.equal(gpt.resolutions, null, "a control the model lacks is hidden");
  assert.equal(banana.nonCommercial, null, "a cloud catalog says nothing about licenses");
  assert.equal(banana.adult, null);
});

test("cloud video models carry durations, audio and last frame", () => {
  const { models } = normalizeProviderModels(fixture("core-media-models-video.json"), "video");
  const veo = models[0];
  assert.equal(veo.id, "google/veo-3.1-fast");
  assert.deepEqual(veo.modes, ["create", "image-to-video"]);
  assert.deepEqual(veo.durations, { values: [4, 6, 8], min: null, max: null, default: 8 });
  assert.equal(veo.audio, true);
  assert.equal(veo.lastFrame, true);
  assert.equal(veo.seed, true);
  assert.deepEqual(veo.resolutions.values, ["720p", "1080p", "4K"]);
});

test("entries without an id, of the other kind, or repeated are dropped", () => {
  const answer = { models: [{ id: "a/b", kind: "image" }, { id: "a/b", kind: "image" }, { kind: "image" }, { id: "v/x", kind: "video" }] };
  assert.deepEqual(normalizeProviderModels(answer, "image").models.map((m) => m.id), ["a/b"]);
  assert.equal(normalizeCloudModel({ id: "x/uncensored-v2", kind: "image" }, "image").adult, true, "a name that says it counts");
});

test("local families are flagged non-commercial and 18+ from license and name", () => {
  const doc = fixture("diffusion-catalog.json");
  const images = normalizeLocalFamilies(doc, "image", "qwen-image-2.1:q4_k_m");
  const byId = Object.fromEntries(images.map((m) => [m.id, m]));
  assert.deepEqual(Object.keys(byId).sort(), ["flux.1-uncensored", "qwen-image-2.1", "z-image"]);
  assert.equal(byId["z-image"].nonCommercial, false);
  assert.equal(byId["z-image"].adult, false);
  assert.equal(byId["flux.1-uncensored"].adult, true);
  assert.equal(byId["flux.1-uncensored"].nonCommercial, true);
  assert.equal(byId["qwen-image-2.1"].nonCommercial, true);
  assert.deepEqual(byId["qwen-image-2.1"].modes, ["create", "reference", "edit"]);
  assert.equal(byId["qwen-image-2.1"].local.loaded, true);
  assert.equal(byId["z-image"].local.loaded, false);
  assert.deepEqual(byId["z-image"].sizes, { kind: "range", min: 256, max: 2048, multiple: 16, defaultWidth: 1024, defaultHeight: 1024 });
  assert.deepEqual(normalizeLocalFamilies(doc, "video").map((m) => m.id), ["ltx-2"]);
  assert.deepEqual(normalizeLocalFamilies(null, "image"), []);
});

test("contentFlags leaves unknown as null", () => {
  assert.deepEqual(contentFlags(null), { nonCommercial: null, adult: null });
  assert.deepEqual(contentFlags("apache-2.0", "z-image"), { nonCommercial: false, adult: false });
  assert.equal(contentFlags("flux-1-dev-non-commercial-license", "flux.1-krea").nonCommercial, true);
});
