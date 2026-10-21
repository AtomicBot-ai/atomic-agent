// Unit tests for main/studio-requests.ts and main/studio-errors.ts, against the built output.
// Run: npm run build && npm run test:unit
// Studio turns the window's form into Core's ImageGenerateRequest / VideoGenerateRequest
// (atomic-chat-core v0.18.6 src/contracts/diffusion.ts) and Core's jobs into what the window draws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { toCoreImageRequest, toCoreVideoRequest, normalizeJob, normalizeItem, withProgress, StudioRequestError } = require("../out/main/studio-requests.js");
const { studioErrorBody, describeStudioError } = require("../out/main/studio-errors.js");
const { StudioCoreError } = require("../out/main/studio-core-client.js");

test("a cloud image request carries target and remote, with Core's required numbers zeroed", () => {
  const body = toCoreImageRequest({
    provider: "openrouter", model: "black-forest-labs/flux-3-image", prompt: "  a red fox  ",
    aspectRatio: "16:9", resolution: "2K", count: 2, seed: 7, quality: "high",
  });
  assert.deepEqual(body, {
    prompt: "a red fox", width: 1344, height: 768, steps: 0, cfgScale: 0, batchSize: 2, workflow: "create", seed: 7,
    target: { provider: "openrouter", model: "black-forest-labs/flux-3-image" },
    remote: { aspectRatio: "16:9", resolution: "2K", quality: "high" },
  });
});

test("edit and reference send their images as Core sources", () => {
  const body = toCoreImageRequest({
    provider: "openrouter", model: "m/x", mode: "reference", prompt: "same cat, in space",
    initImage: { path: "/a/cat.png" }, referenceImages: [{ base64: "iVBORw0KGgo=" }, { path: "/a/b.png" }],
  });
  assert.equal(body.workflow, "reference");
  assert.deepEqual(body.initImage, { path: "/a/cat.png" });
  assert.deepEqual(body.referenceImages, [{ base64: "iVBORw0KGgo=" }, { path: "/a/b.png" }]);
});

test("refusals happen before Core is asked", () => {
  const bad = (req) => assert.throws(() => toCoreImageRequest(req), StudioRequestError);
  bad({ provider: "openrouter", model: "m/x", prompt: "" });
  bad({ provider: "openrouter", model: "m/x", prompt: "x", mode: "edit" });                 // no source
  bad({ provider: "openrouter", model: "m/x", prompt: "x", mode: "inpaint", initImage: { path: "/a" } }); // no mask
  bad({ provider: "elsewhere", model: "m/x", prompt: "x" });
  bad({ provider: "openrouter", model: "m/x", prompt: "x", mode: "paint" });
  bad({ provider: "openrouter", model: "m/x", prompt: "x", mode: "edit", initImage: { url: "http://x" } });
  bad({ provider: "openrouter", model: "", prompt: "x" });
});

test("a local image request takes the loaded model's defaults, and fails without them", () => {
  const defaults = { width: 1024, height: 1024, steps: 8, cfgScale: 1 };
  const body = toCoreImageRequest({ provider: "local", model: "z-image:q4_k_m", prompt: "x", steps: 12 }, defaults);
  assert.deepEqual(body, { prompt: "x", width: 1024, height: 1024, steps: 12, cfgScale: 1, batchSize: 1, workflow: "create" });
  assert.equal(body.target, undefined);
  assert.throws(() => toCoreImageRequest({ provider: "local", model: "z", prompt: "x" }), /Load a local image model/);
});

test("a cloud video request maps duration, audio and frames to Core's remote options", () => {
  const body = toCoreVideoRequest({
    provider: "openrouter", model: "google/veo-3.1-fast", mode: "image-to-video", prompt: "",
    durationSecs: 8, resolution: "720p", aspectRatio: "16:9", audio: false,
    firstFrame: { path: "/a/first.png" }, lastFrame: { base64: "AAAA" }, frames: 99,
  });
  assert.equal(body.workflow, "image-to-video");
  assert.deepEqual(body.initImage, { path: "/a/first.png" });
  assert.deepEqual(body.endImage, { base64: "AAAA" });
  assert.deepEqual(body.target, { provider: "openrouter", model: "google/veo-3.1-fast" });
  assert.deepEqual(body.remote, { durationSecs: 8, resolution: "720p", aspectRatio: "16:9", generateAudio: false });
  assert.equal(body.frames, undefined, "frames are a local control");
  assert.throws(() => toCoreVideoRequest({ provider: "openrouter", model: "m/v", mode: "image-to-video", prompt: "x" }), /first frame/);
  assert.throws(() => toCoreVideoRequest({ provider: "local", model: "ltx-2", mode: "image-to-video", prompt: "x", firstFrame: { path: "/a" } }, { width: 768, height: 512, steps: 8, cfgScale: 1 }), /cloud models only/);
});

test("Core's job, progress and gallery item become the window's shapes", () => {
  const item = {
    id: "abc-00", path: "/d/images/abc-00.png", thumbnailPath: "/d/images/.thumbs/abc-00.png", width: 1024, height: 768,
    sizeBytes: 1234, createdAtMs: 5, pinned: true, archived: false,
    recipe: { prompt: "fox", model: { modelId: "black-forest-labs/flux-3-image", displayName: "FLUX.3", family: "openrouter" }, engine: { kind: "remote", provider: "openrouter", api: "openrouter-images" } },
  };
  const job = normalizeJob({
    id: "abc", state: "completed", modelId: "black-forest-labs/flux-3-image", createdAtMs: 1, finishedAtMs: 9,
    request: { prompt: "fox", target: { provider: "openrouter", model: "black-forest-labs/flux-3-image" } },
    progress: { phase: "saving", step: 1, totalSteps: 1, fraction: 1.2, etaSeconds: null, batchIndex: 0, batchSize: 1, elapsedMs: 9 },
    outputs: [item],
  }, "image");
  assert.equal(job.cloud, true);
  assert.equal(job.progress.fraction, 1, "clamped");
  assert.equal(job.outputs[0].model.provider, "openrouter");
  assert.equal(job.outputs[0].thumbnailPath, "/d/images/.thumbs/abc-00.png");
  const video = normalizeItem({ id: "f".repeat(32), path: "/d/videos/x.mp4", posterPath: null, durationSecs: 0, recipe: { durationSecs: 8, engine: { kind: "sd-cpp" }, model: {} } }, "video");
  assert.equal(video.durationSecs, 8);
  assert.equal(video.model.provider, "local");
  assert.equal(normalizeJob({ id: "x", state: "weird" }, "image"), null);
  const moved = withProgress({ ...job, state: "queued", progress: null }, { phase: "sampling", step: 3, totalSteps: 8, fraction: 0.4, etaSeconds: 5, slowdown: true });
  assert.equal(moved.state, "generating");
  assert.equal(moved.progress.slowdown, true);
});

test("errors reach the window as {code, message} in words a person can act on", () => {
  assert.deepEqual(studioErrorBody(new StudioRequestError("Write a prompt first.")), { code: "INVALID_REQUEST", message: "Write a prompt first." });
  const quota = studioErrorBody(new StudioCoreError("Insufficient credits", "REMOTE_QUOTA", 402), true);
  assert.equal(quota.code, "REMOTE_QUOTA");
  assert.match(quota.message, /out of credits/);
  assert.match(describeStudioError("JOB_BUSY", "", true), /Four cloud generations/);
  assert.match(describeStudioError("NO_KEY", "", true), /OpenRouter API key/);
  assert.equal(studioErrorBody(new Error("boom")).code, "FAILED");
});
