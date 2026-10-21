// Unit tests for main/studio-paths.ts and the SSE/job helpers, against the built output.
// Run: npm run build && npm run test:unit
// Show in Finder, Save as… and the preview open only files inside Studio's output folders,
// resolved through links; an input image path is taken only from there or from the dialog.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { insideRoots, PickedPaths, sourceAllowed, requestSources, readStudioSettings, writeStudioSettings } = require("../out/main/studio-paths.js");
const { parseSseFrames } = require("../out/main/studio-core-client.js");
const { jobFromFrame, jobPath } = require("../out/main/studio-jobs.js");
const { studioCorePaths, studioCoreEnv } = require("../out/main/studio-core-start.js");

const base = mkdtempSync(join(tmpdir(), "studio-paths-"));
after(() => rmSync(base, { recursive: true, force: true }));
const images = join(base, "images");
const outside = join(base, "outside");
mkdirSync(images);
mkdirSync(outside);
writeFileSync(join(images, "a.png"), "x");
writeFileSync(join(outside, "secret.txt"), "x");
symlinkSync(join(outside, "secret.txt"), join(images, "link.png"));

test("only files inside an output folder pass, links are judged by where they lead", () => {
  assert.ok(insideRoots(join(images, "a.png"), [images]));
  assert.equal(insideRoots(join(images, "link.png"), [images]), null);
  assert.equal(insideRoots(join(images, "..", "outside", "secret.txt"), [images]), null);
  assert.equal(insideRoots(images, [images]), null, "the folder itself is not a file in it");
  assert.equal(insideRoots("relative/a.png", [images]), null);
  assert.equal(insideRoots(join(images, "missing.png"), [images]), null);
  assert.equal(insideRoots(42, [images]), null);
});

test("an input path is allowed from the gallery or the dialog; bytes always", () => {
  const picked = new PickedPaths();
  assert.ok(sourceAllowed({ path: join(images, "a.png") }, [images], picked));
  assert.ok(!sourceAllowed({ path: join(outside, "secret.txt") }, [images], picked));
  picked.add(join(outside, "secret.txt"));
  assert.ok(sourceAllowed({ path: join(outside, "secret.txt") }, [images], picked));
  assert.ok(sourceAllowed({ base64: "AAAA" }, [images], picked));
  assert.ok(!sourceAllowed({ base64: "" }, [images], picked));
  assert.ok(!sourceAllowed(null, [images], picked));
  assert.deepEqual(requestSources({ initImage: 1, maskImage: 2, endImage: 3, referenceImages: [4, 5] }), [1, 2, 3, 4, 5]);
});

test("settings keep only absolute folders", () => {
  writeStudioSettings(base, { imageOutputDir: images });
  assert.deepEqual(readStudioSettings(base), { imageOutputDir: images });
  writeFileSync(join(base, "studio.json"), JSON.stringify({ imageOutputDir: "rel/dir", videoOutputDir: 3 }));
  assert.deepEqual(readStudioSettings(base), {});
  assert.deepEqual(readStudioSettings(join(base, "nope")), {});
});

test("Core's event frames parse, partial frames wait for the rest", () => {
  const { frames, rest } = parseSseFrames('id: 1\nevent: diffusion:progress\ndata: {"jobId":"j","progress":{"step":2}}\n\nid: 2\nevent: diffusion:job\ndata: {"jo');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, "diffusion:progress");
  assert.equal(rest.startsWith("id: 2"), true);
  assert.equal(parseSseFrames("event: x\ndata: not json\n\n").frames.length, 0);
});

test("frames become job updates only for jobs already seen", () => {
  const seen = { id: "j", kind: "video", state: "queued", cloud: true, model: "m", progress: null, outputs: [], error: null, createdAtMs: 0, finishedAtMs: null };
  const progress = jobFromFrame({ event: "diffusion:video-progress", data: { jobId: "j", progress: { phase: "sampling", step: 1, totalSteps: 4, fraction: 0.25 } } }, (id) => (id === "j" ? seen : undefined));
  assert.equal(progress.state, "generating");
  assert.equal(jobFromFrame({ event: "diffusion:progress", data: { jobId: "other" } }, () => undefined), null);
  assert.equal(jobFromFrame({ event: "diffusion:job", data: { job: { id: "k", state: "completed", outputs: [] } } }, () => undefined).kind, "image");
  assert.equal(jobFromFrame({ event: "resync", data: {} }, () => undefined), null);
  assert.equal(jobPath("video", "a/b"), "/diffusion/video/jobs/a%2Fb");
});

test("Core's paths follow the agent's layout and its daemon gets no secrets", () => {
  const p = studioCorePaths("/data", "0.18.6", "darwin");
  assert.equal(p.dataFolder, "/data/core/versions/0.18.6/data");
  assert.equal(p.lock, "/data/core/versions/0.18.6/data/atomic-core/instance.lock");
  assert.equal(p.binary, "/data/core/versions/0.18.6/atomic-chat-core");
  assert.throws(() => studioCorePaths("/data", "../x"));
  const env = studioCoreEnv({ PATH: "/bin", OPENROUTER_API_KEY: "k", MY_TOKEN: "t", HOME: "/h" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", ATOMIC_CORE_TELEMETRY: "off" });
});
