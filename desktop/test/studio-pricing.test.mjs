// Unit tests for main/studio-pricing.ts, against the built output.
// Run: npm run build && npm run test:unit
// The Generate button shows an approximate price only when OpenRouter publishes one per
// image or per second; a model billed per token, or an unknown SKU, gets no number.
// Fixtures are trimmed live answers of /api/v1/images/models/<id>/endpoints and
// /api/v1/videos/models (2026-10-21).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { imagePriceFromEndpoints, videoPriceFromSkus, StudioPricing, PRICING_TTL_MS } = require("../out/main/studio-pricing.js");
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/studio/${name}`, import.meta.url), "utf8"));
const skusOf = (id) => fixture("openrouter-videos-models.json").data.find((m) => m.id === id).pricing_skus;

test("an image tier listed per image gives that price times the count", () => {
  const flux = fixture("openrouter-image-endpoints-flux.json");
  assert.deepEqual(imagePriceFromEndpoints(flux, { kind: "image", resolution: "2K", count: 2 }), { usd: 0.2, maxUsd: null, basis: "0.1 USD per image × 2" });
  // No tier asked for, none untiered: the whole span.
  const any = imagePriceFromEndpoints(flux, { kind: "image" });
  assert.equal(any.usd, 0.041);
  assert.equal(any.maxUsd, 0.607);
});

test("a model billed per token gets no number", () => {
  assert.equal(imagePriceFromEndpoints(fixture("openrouter-image-endpoints-tokens.json"), { kind: "image" }), null);
  assert.equal(imagePriceFromEndpoints({}, { kind: "image" }), null);
});

test("providers that disagree give a range; input lines are not output prices", () => {
  const p = imagePriceFromEndpoints(fixture("openrouter-image-endpoints-two-providers.json"), { kind: "image" });
  assert.deepEqual(p, { usd: 0.018, maxUsd: 0.025, basis: "0.018 USD per image" });
});

test("video: the most specific SKU wins, audio decides, cents are cents", () => {
  assert.equal(videoPriceFromSkus(skusOf("google/veo-3.1-fast"), { kind: "video", durationSecs: 8, resolution: "720p", audio: false }).usd, 0.64);
  assert.equal(videoPriceFromSkus(skusOf("google/veo-3.1-fast"), { kind: "video", durationSecs: 8, resolution: "4K", audio: true }).usd, 2.4);
  const unsure = videoPriceFromSkus(skusOf("google/veo-3.1-fast"), { kind: "video", durationSecs: 4, resolution: "720p" });
  assert.deepEqual([unsure.usd, unsure.maxUsd], [0.32, 0.4], "sound left to the provider: a range");
  assert.equal(videoPriceFromSkus(skusOf("kwaivgi/kling-v3.0-std"), { kind: "video", durationSecs: 10, resolution: "1080p", mode: "image-to-video" }).usd, 0.84);
  assert.equal(videoPriceFromSkus(skusOf("x-ai/grok-imagine-video-1.5-lite"), { kind: "video", durationSecs: 5, resolution: "720p" }).usd, 0.15);
});

test("video without a duration, or only token SKUs, gets no number", () => {
  assert.equal(videoPriceFromSkus(skusOf("google/veo-3.1-fast"), { kind: "video", resolution: "720p" }), null);
  assert.equal(videoPriceFromSkus(skusOf("example/tokens-only"), { kind: "video", durationSecs: 5 }), null);
  assert.equal(videoPriceFromSkus(skusOf("x-ai/grok-imagine-video-1.5-lite"), { kind: "video", durationSecs: 5 }), null, "per-resolution only, none asked");
});

test("answers are cached for a day, failures are null, odd ids are not fetched", async () => {
  let now = 1_000;
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    if (url.endsWith("/videos/models")) return new Response(JSON.stringify(fixture("openrouter-videos-models.json")));
    if (url.includes("/images/models/black-forest-labs/flux-3-image/endpoints")) return new Response(JSON.stringify(fixture("openrouter-image-endpoints-flux.json")));
    return new Response("nope", { status: 500 });
  };
  const pricing = new StudioPricing(fake, () => now);
  assert.equal((await pricing.price("black-forest-labs/flux-3-image", { kind: "image", resolution: "1K" })).usd, 0.048);
  await pricing.price("black-forest-labs/flux-3-image", { kind: "image", resolution: "2K" });
  assert.equal(calls.length, 1);
  now += PRICING_TTL_MS + 1;
  await pricing.price("black-forest-labs/flux-3-image", { kind: "image" });
  assert.equal(calls.length, 2);
  assert.equal((await pricing.price("google/veo-3.1-fast", { kind: "video", durationSecs: 8, resolution: "720p", audio: true })).usd, 0.8);
  assert.equal(await pricing.price("missing/model", { kind: "image" }), null);
  assert.equal(await pricing.price("../../etc", { kind: "image" }), null);
  assert.ok(!calls.some((u) => u.includes("..")));
});
