// Unit tests for main/studio-local.ts, main/studio-download.ts and disk-space.ts diskShortfall,
// against the built output.
// Run: npm run build && npm run test:unit
// Local diffusion models: the conf catalog parsed with every path checked, what is on disk
// merged in, the fit verdict for this machine, the files a delete frees, the load request
// Core takes, and the resumable, verified download.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const L = require("../out/main/studio-local.js");
const { DIFFUSION_CATALOG_BASELINE } = require("../out/main/studio-diffusion-baseline.js");
const { downloadModelFile } = require("../out/main/studio-download.js");
const { diskShortfall } = require("../out/main/disk-space.js");

const GIB = 1024 ** 3;
const base = mkdtempSync(join(tmpdir(), "studio-local-"));
after(() => rmSync(base, { recursive: true, force: true }));

const catalog = L.parseDiffusionCatalog(DIFFUSION_CATALOG_BASELINE);
const fam = (id) => catalog.families.find((f) => f.id === id);
const clone = (v) => JSON.parse(JSON.stringify(v));

/* ------------------------------------------------------------ catalog */

test("the shipped catalog parses whole: 13 families, nothing skipped", () => {
  assert.equal(catalog.families.length, 13);
  assert.deepEqual(catalog.skipped, []);
  const z = fam("z-image");
  assert.equal(z.modality, "image");
  assert.equal(z.quants.find((q) => q.recommended).id, "q4_k_m");
  assert.equal(z.textEncoders[0].field, "llm");
  assert.equal(fam("krea-2-turbo").gated, true);
  assert.equal(fam("ltx-2").video.frameStep, 8);
  assert.ok(fam("ltx-2").audioVae);
});

test("a family with a path, repo or id that could leave the models folder is dropped, the rest kept", () => {
  const doc = clone(DIFFUSION_CATALOG_BASELINE);
  doc.families[0].transformer.quants[0].filename = "../../etc/passwd";
  doc.families[1].vae.repo = "owner/../escape";
  doc.families[2].id = "shared";
  doc.families[3].text_encoders[0].sha256 = "not-a-sha";
  doc.families[4].text_encoders[0].field = "something-new";
  const parsed = L.parseDiffusionCatalog(doc);
  assert.equal(parsed.families.length, 8);
  assert.equal(parsed.skipped.length, 5);
  assert.equal(L.parseDiffusionCatalog({ ...doc, schema_version: 2 }), null, "another schema is not guessed at");
  assert.equal(L.parseDiffusionCatalog(null), null);
});

test("artifact ids are <family>:<quant>", () => {
  assert.deepEqual(L.parseArtifactId("z-image:q4_k_m"), { family: "z-image", quant: "q4_k_m" });
  assert.deepEqual(L.parseArtifactId("qwen-image-2.1-turbo:ad_q4_k"), { family: "qwen-image-2.1-turbo", quant: "ad_q4_k" });
  for (const bad of ["z-image", ":q4", "z-image:", "../x:q4", "z-image:q4/../../x", 42, null]) assert.equal(L.parseArtifactId(bad), null, String(bad));
  assert.equal(L.findArtifact(catalog, "z-image:q4_k_m").quant.bytes, 5017613376);
  assert.equal(L.findArtifact(catalog, "z-image:q9"), null);
});

/* ------------------------------------------------------------- paths */

test("save paths stay strictly inside the models root", () => {
  const root = join(base, "models");
  assert.equal(L.savePathUnder(root, "z-image/a.gguf"), join(root, "z-image", "a.gguf"));
  assert.equal(L.savePathUnder(root, "shared/unsloth--Repo/ae.safetensors"), join(root, "shared", "unsloth--Repo", "ae.safetensors"));
  for (const bad of ["../a.gguf", "z-image/../../a.gguf", "/etc/passwd", "z-image\\..\\a", ".hidden/a", "z-image/.a", "", "a//b", "a\0b"]) {
    assert.equal(L.savePathUnder(root, bad), null, bad);
  }
  assert.equal(L.savePathUnder("relative/root", "a.gguf"), null);
  assert.ok(L.isSafeRepo("unsloth/Z-Image-Turbo-GGUF"));
  assert.ok(!L.isSafeRepo("unsloth/Z/extra"));
  assert.ok(!L.isSafeRepo("../x"));
  assert.ok(L.isSafeRepoFile("split_files/vae/ae.safetensors"));
  assert.ok(!L.isSafeRepoFile("split_files/../ae.safetensors"));
  assert.equal(L.diffusionModelsDir("/data"), join("/data", "diffusion", "models"));
});

/* ---------------------------------------------------- catalog x disk */

test("a plan puts the transformer under the family and side files under shared/", () => {
  const root = join(base, "plan");
  const plan = L.planArtifact(fam("z-image"), "q4_k_m", [], root);
  assert.equal(plan.id, "z-image:q4_k_m");
  const [t, vae, te] = plan.entries;
  assert.equal(t.relativePath, "z-image/z-image-turbo-Q4_K_M.gguf");
  assert.equal(t.url, "https://huggingface.co/unsloth/Z-Image-Turbo-GGUF/resolve/main/z-image-turbo-Q4_K_M.gguf");
  assert.equal(vae.relativePath, "shared/unsloth--Z-Image-Turbo-ComfyUI/ae.safetensors");
  assert.equal(te.relativePath, "shared/unsloth--Qwen3-4B-Instruct-2507-GGUF/Qwen3-4B-Instruct-2507-Q4_K_M.gguf");
  assert.equal(t.savePath, join(root, "z-image", "z-image-turbo-Q4_K_M.gguf"));
  assert.equal(plan.totalBytes, 5017613376 + 335304388 + 2497281120);
  assert.equal(plan.missingBytes, plan.totalBytes);
});

test("a file on disk counts only at its catalog size; a shared VAE is not fetched twice", () => {
  const z = L.planArtifact(fam("z-image"), "q4_k_m", [], "");
  const vae = z.entries.find((e) => e.kind === "vae");
  // Z-Image and the FLUX.1 families use the same ae.safetensors.
  const flux = L.planArtifact(fam("flux.1"), "q4_k_m", [{ path: "/x", relativePath: vae.relativePath, bytes: vae.bytes }], "");
  assert.equal(flux.entries.find((e) => e.kind === "vae").present, true);
  assert.equal(flux.missingBytes, flux.totalBytes - vae.bytes);
  const truncated = [{ path: "/x", relativePath: vae.relativePath, bytes: vae.bytes - 1 }];
  assert.equal(L.planArtifact(fam("z-image"), "q4_k_m", truncated, "").entries.find((e) => e.kind === "vae").present, false);
});

test("Qwen-Image-2.1's vision projector is needed for edit and reference only", () => {
  const q = fam("qwen-image-2.1");
  const create = L.planArtifact(q, q.quants[0].id, [], "", "create");
  const edit = L.planArtifact(q, q.quants[0].id, [], "", "edit");
  const proj = create.entries.find((e) => e.field === "llm_vision");
  assert.equal(proj.required, false);
  assert.equal(edit.entries.find((e) => e.field === "llm_vision").required, true);
  assert.equal(edit.totalBytes - create.totalBytes, proj.bytes);
});

const filesOf = (plan) => plan.entries.filter((e) => e.required).map((e) => ({ path: `/m/${e.relativePath}`, relativePath: e.relativePath, bytes: e.bytes }));

test("installed artifacts and what deleting one frees", () => {
  const z = L.planArtifact(fam("z-image"), "q4_k_m", [], "");
  const zFiles = filesOf(z);
  const vae = z.entries.find((e) => e.kind === "vae");
  const fFiles = filesOf(L.planArtifact(fam("flux.1"), "q4_k_m", [], "")).filter((f) => f.relativePath !== vae.relativePath);
  const files = [...zFiles, ...fFiles];
  const installed = L.installedArtifacts(catalog, files);
  assert.deepEqual(installed.map((a) => [a.id, a.complete]).sort(), [["flux.1:q4_k_m", true], ["z-image:q4_k_m", true]]);
  const { remove, kept } = L.planDeletion(catalog, fam("z-image"), "q4_k_m", files);
  assert.deepEqual(kept.map((f) => f.relativePath), [vae.relativePath], "the VAE FLUX.1 needs stays");
  assert.ok(remove.some((f) => f.relativePath === z.entries[0].relativePath));
  assert.equal(remove.length, 2, "the transformer and Z-Image's own text encoder");
  // Alone, everything of it goes.
  assert.equal(L.planDeletion(catalog, fam("z-image"), "q4_k_m", zFiles).remove.length, zFiles.length);
  // A half-downloaded artifact is listed, not complete.
  const partial = L.installedArtifacts(catalog, [zFiles[0]]);
  assert.equal(partial[0].complete, false);
  assert.equal(partial[0].missing.length, 2);
});

test("listModelFiles skips hidden files, partial downloads and links", () => {
  const root = join(base, "list");
  mkdirSync(join(root, "z-image"), { recursive: true });
  mkdirSync(join(root, "shared", "o--r"), { recursive: true });
  writeFileSync(join(root, "z-image", "a.gguf"), "abc");
  writeFileSync(join(root, "z-image", "b.gguf.part"), "ab");
  writeFileSync(join(root, "shared", "o--r", ".hidden"), "x");
  writeFileSync(join(root, "shared", "o--r", "vae.safetensors"), "12345");
  symlinkSync(join(root, "z-image", "a.gguf"), join(root, "z-image", "link.gguf"));
  return L.listModelFiles(root).then((files) => {
    assert.deepEqual(files.map((f) => [f.relativePath, f.bytes]), [["shared/o--r/vae.safetensors", 5], ["z-image/a.gguf", 3]]);
    return L.listModelFiles(join(base, "absent")).then((none) => assert.deepEqual(none, []));
  });
});

/* --------------------------------------------------------------- fit */

test("fit: Z-Image Q4 on Macs of 8, 12 and 32 GB and on a 10 and 16 GB PC", () => {
  const z = fam("z-image");
  const q4 = z.quants.find((q) => q.id === "q4_k_m");
  const mac = (gb) => L.machineProfile(gb * GIB, "darwin", "arm64");
  const pc = (gb) => L.machineProfile(gb * GIB, "linux", "x64");
  assert.equal(mac(16).budgetBytes, 16 * GIB * L.MACOS_LOAD_CEILING);
  assert.equal(mac(16).teOnCpu, true);
  assert.equal(pc(16).teOnCpu, false);
  // Mac: 5.02 GB weights + 0.34 GB VAE + 1.5 GiB activations, the encoder on the CPU.
  assert.equal(L.fitFor(z, q4, mac(32)).verdict, "ok");
  assert.equal(L.fitFor(z, q4, mac(12)).verdict, "ok");
  assert.equal(L.fitFor(z, q4, mac(8)).verdict, "no");
  assert.equal(L.fitFor(z, q4, mac(8)).policy, "model");
  // PC: the 2.5 GB encoder counts too.
  assert.equal(L.fitFor(z, q4, pc(16)).verdict, "ok");
  assert.equal(L.fitFor(z, q4, pc(10)).verdict, "maybe");
  assert.equal(L.fitFor(z, q4, pc(10)).policy, "group");
  const unknown = L.fitFor(z, q4, null);
  assert.equal(unknown.verdict, "maybe");
  assert.equal(unknown.budgetBytes, null);
  assert.equal(L.machineProfile(0), null);
});

test("the recommended quant steps down to one that runs here, and none when nothing does", () => {
  const z = fam("z-image");
  const mac = (gb) => L.machineProfile(gb * GIB, "darwin", "arm64");
  assert.equal(L.recommendedQuant(z, mac(32)).id, "q4_k_m", "the curated pick when it fits");
  assert.equal(L.recommendedQuant(z, mac(8)).id, "q3_k_m", "the largest that may run");
  assert.equal(L.recommendedQuant(fam("ltx-2"), mac(8)), null);
});

test("the family view merges disk, fit and downloads", () => {
  const z = fam("z-image");
  const zFiles = filesOf(L.planArtifact(z, "q4_k_m", [], ""));
  const profile = L.machineProfile(32 * GIB, "darwin", "arm64");
  const downloads = new Map([["z-image:q8_0", { id: "z-image:q8_0", state: "downloading", transferred: 1, total: 2, percent: 50, file: null, error: null }]]);
  const view = L.localFamilyView(z, zFiles, profile, { loadedId: "z-image:q4_k_m", downloads });
  const byId = Object.fromEntries(view.quants.map((q) => [q.id, q]));
  assert.equal(view.installed, true);
  assert.equal(view.defaultQuant, "z-image:q4_k_m");
  assert.equal(byId["z-image:q4_k_m"].installed, true);
  assert.equal(byId["z-image:q4_k_m"].downloadBytes, 0);
  assert.equal(byId["z-image:q4_k_m"].loaded, true);
  assert.equal(byId["z-image:q4_k_m"].recommended, true);
  // Another quant shares the VAE and encoder: partly here, only its transformer to fetch.
  assert.equal(byId["z-image:q3_k_m"].partial, true);
  assert.equal(byId["z-image:q3_k_m"].downloadBytes, z.quants.find((q) => q.id === "q3_k_m").bytes);
  assert.equal(byId["z-image:q8_0"].download.percent, 50);
  const empty = L.localFamilyView(z, [], L.machineProfile(8 * GIB, "darwin", "arm64"));
  assert.equal(empty.installed, false);
  assert.equal(empty.defaultQuant, "z-image:q3_k_m");
});

/* -------------------------------------------------------------- load */

test("the load request maps side files onto Core's slots", () => {
  const flux = fam("flux.1");
  const files = filesOf(L.planArtifact(flux, "q4_k_m", [], ""));
  const req = L.buildLoadRequest(flux, "q4_k_m", files, "/m", { offload: "none" });
  assert.equal(req.modelId, "flux.1:q4_k_m");
  assert.equal(req.modality, "image");
  assert.ok(req.files.diffusionModel.endsWith(".gguf"));
  assert.ok(req.files.clipL && req.files.t5xxl && req.files.vae);
  assert.equal(req.defaults.cfgScale, flux.defaults.cfgScale);
  assert.equal(req.offloadFallback, "model");
  const ltx = fam("ltx-2");
  const lreq = L.buildLoadRequest(ltx, "q4_k_m", [], "/m", { offload: "model" });
  assert.ok(lreq.files.audioVae && lreq.files.embeddingsConnectors && lreq.files.llm);
  assert.equal(lreq.defaults.video.frameStep, 8);
  assert.deepEqual(lreq.ranges.frames, ltx.video.frameRange);
  assert.equal(lreq.offloadFallback, undefined);
  assert.equal(lreq.files.diffusionModel, join("/m", "ltx-2", ltx.quants.find((q) => q.id === "q4_k_m").filename.split("/").pop()));
  const q = fam("qwen-image-2.1");
  assert.equal(L.buildLoadRequest(q, q.quants[0].id, [], "/m", { offload: "none" }).files.llmVision, undefined);
  assert.ok(L.buildLoadRequest(q, q.quants[0].id, [], "/m", { offload: "none", workflow: "edit" }).files.llmVision);
  assert.equal(L.offloadFor(fam("qwen-image"), L.fitFor(fam("qwen-image"), fam("qwen-image").quants[0], null), "darwin"), "model");
});

/* ------------------------------------------------------------- disk */

test("ATO-507's sentence before a download that cannot fit", () => {
  assert.equal(diskShortfall(19.7 * GIB, { freeBytes: 12.15 * GIB, totalBytes: 500 * GIB, path: "/" }), "Needs 19.7 GB, 12.1 GB free on this disk.");
  assert.equal(diskShortfall(10 * GIB, { freeBytes: 10.5 * GIB, totalBytes: 500 * GIB, path: "/" }), "Needs 10 GB and some room to spare, 10.5 GB free on this disk.");
  assert.equal(diskShortfall(10 * GIB, { freeBytes: 20 * GIB, totalBytes: 500 * GIB, path: "/" }), null);
  assert.equal(diskShortfall(10 * GIB, null), null, "an unknown disk blocks nothing");
});

/* ---------------------------------------------------------- download */

const payload = Buffer.from("local diffusion weights ".repeat(4096));
const sha = createHash("sha256").update(payload).digest("hex");

/** A server that honours Range; `calls` records each request's Range header. */
function fakeServer(body = payload, { status } = {}) {
  const calls = [];
  const request = async (url, init) => {
    const range = init?.headers?.Range ?? null;
    calls.push({ url, range, auth: init?.headers?.Authorization ?? null });
    if (status) return new Response("no", { status });
    const from = range ? Number(/bytes=(\d+)-/.exec(range)[1]) : 0;
    return new Response(body.subarray(from), { status: range ? 206 : 200 });
  };
  return { request, calls };
}

test("a download lands verified, and a part file is resumed with a range", async () => {
  const root = join(base, "dl");
  const savePath = join(root, "z-image", "w.gguf");
  const { request, calls } = fakeServer();
  let gained = 0;
  await downloadModelFile({ url: "https://huggingface.co/o/r/resolve/main/w.gguf", savePath, bytes: payload.length, sha256: sha }, { root: (mkdirSync(root, { recursive: true }), root), request, onBytes: (d) => { gained += d; } });
  assert.deepEqual(readFileSync(savePath), payload);
  assert.equal(gained, payload.length);
  assert.equal(calls[0].range, null);

  const resumed = join(root, "z-image", "r.gguf");
  writeFileSync(`${resumed}.part`, payload.subarray(0, 1000));
  const second = fakeServer();
  await downloadModelFile({ url: "https://huggingface.co/o/r/resolve/main/r.gguf", savePath: resumed, bytes: payload.length, sha256: sha }, { root, request: second.request });
  assert.equal(second.calls[0].range, "bytes=1000-");
  assert.deepEqual(readFileSync(resumed), payload);
  assert.equal(existsSync(`${resumed}.part`), false);

  const again = fakeServer();
  await downloadModelFile({ url: "https://x/y", savePath: resumed, bytes: payload.length, sha256: sha }, { root, request: again.request });
  assert.equal(again.calls.length, 0, "a file already in place is not fetched again");
});

test("a damaged file is deleted, a gated repo says so, a link out of the root is refused", async () => {
  const root = join(base, "dl2");
  mkdirSync(root, { recursive: true });
  const savePath = join(root, "f", "bad.gguf");
  const tampered = Buffer.from(payload);
  tampered[10] ^= 1;
  await assert.rejects(
    downloadModelFile({ url: "https://h/x", savePath, bytes: payload.length, sha256: sha }, { root, request: fakeServer(tampered).request }),
    (err) => err.code === "CHECKSUM_MISMATCH");
  assert.equal(existsSync(`${savePath}.part`), false);
  assert.equal(existsSync(savePath), false);

  await assert.rejects(
    downloadModelFile({ url: "https://h/x", savePath: join(root, "f", "g.gguf"), bytes: 10, sha256: null }, { root, request: fakeServer(payload, { status: 401 }).request }),
    (err) => err.code === "GATED");

  const outside = join(base, "outside");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(root, "escape"));
  await assert.rejects(
    downloadModelFile({ url: "https://h/x", savePath: join(root, "escape", "w.gguf"), bytes: 10, sha256: null }, { root, request: fakeServer().request }),
    (err) => err.code === "OUTSIDE");
  assert.equal(existsSync(join(outside, "w.gguf.part")), false);
});

test("a server that sends more than the catalog says is cut off", async () => {
  const root = join(base, "dl3");
  mkdirSync(root, { recursive: true });
  await assert.rejects(
    downloadModelFile({ url: "https://h/x", savePath: join(root, "f", "big.gguf"), bytes: 100, sha256: null }, { root, request: fakeServer().request, retries: 0 }),
    (err) => err.code === "SIZE_MISMATCH");
});
