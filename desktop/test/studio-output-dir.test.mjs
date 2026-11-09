// Unit tests for StudioMedia.outputDir in main/studio-media.ts, against the built output.
// Run: npm run build && npm run test:unit
// The window asks for the output folders at every launch. Answering must not
// start or install Atomic Core: a daemon started for that outlived the app.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { StudioMedia } = require("../out/main/studio-media.js");
const { writeStudioSettings } = require("../out/main/studio-paths.js");

const VERSION = "0.18.6";
const roots = [];
after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

function studioIn() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "studio-output-dir-")));
  roots.push(root);
  const dataDir = join(root, "models");
  const studio = new StudioMedia({
    dataDir: () => dataDir, stateDir: root, coreVersion: VERSION, openRouterKey: async () => null,
    emitJob: () => {}, emitLocal: () => {},
    coreRequest: () => { throw new Error("outputDir must not download Core"); },
  });
  return { root, dataDir, studio };
}

test("with no Core, the default folder is answered and Core is neither installed nor started", async () => {
  const { dataDir, studio } = studioIn();
  assert.deepEqual(await studio.outputDir("image"), { path: join(dataDir, "studio", "images"), isDefault: true });
  assert.deepEqual(await studio.outputDir("video"), { path: join(dataDir, "studio", "videos"), isDefault: true });
  assert.equal(existsSync(join(dataDir, "core")), false);
});

test("with no Core, a folder chosen in Settings is answered", async () => {
  const { root, studio } = studioIn();
  writeStudioSettings(root, { imageOutputDir: "/chosen/pictures" });
  assert.deepEqual(await studio.outputDir("image"), { path: "/chosen/pictures", isDefault: false });
});

test("a running Core this app has not configured is not asked for its folders", async () => {
  const { dataDir, studio } = studioIn();
  const dataFolder = join(dataDir, "core", "versions", VERSION, "data");
  const seen = [];
  const core = createServer((req, res) => {
    seen.push(req.url);
    res.setHeader("content-type", "application/json");
    res.setHeader("connection", "close");
    res.end(JSON.stringify(req.url.endsWith("/snapshot")
      ? { instance_id: "someone-elses", version: VERSION, protocol: 2, owner_scope: "cli", data_folder: dataFolder }
      : { outputDir: "/core/own/images" }));
  });
  await new Promise((r) => core.listen(0, "127.0.0.1", r));
  after(() => core.close());
  mkdirSync(join(dataFolder, "atomic-core"), { recursive: true });
  writeFileSync(join(dataFolder, "atomic-core", "control-token"), "token");
  writeFileSync(join(dataFolder, "atomic-core", "instance.lock"), JSON.stringify({
    state: "ready", instance_id: "someone-elses", control_host: "127.0.0.1", control_port: core.address().port,
  }));
  assert.deepEqual(await studio.outputDir("image"), { path: join(dataDir, "studio", "images"), isDefault: true });
  assert.ok(seen.some((u) => u.endsWith("/snapshot")), `Core was asked: ${seen}`);
  assert.equal(seen.some((u) => u.includes("/diffusion/")), false, `Core was asked: ${seen}`);
});
