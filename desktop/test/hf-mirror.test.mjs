// The Hugging Face mirror, against the built output (npm run build first)
// and renderer/hf-mirror.js: the endpoint port in main/huggingface.ts
// (rewrite, HF_ENDPOINT over the config, canonical URLs kept), the
// unreachable message and its hint, the listing and the projector going to
// the mirror, the field's rule and write (main/hf-mirror.ts), and the
// field's markup.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HF = require("../out/main/huggingface.js");
const M = require("../out/main/hf-mirror.js");
const C = require("../out/main/analytics/classify.js");
const R = require("../renderer/hf-mirror.js");

const CANONICAL = "https://huggingface.co/unsloth/gemma-4-E4B-it-qat-GGUF/resolve/main/mmproj-BF16.gguf";
const MIRROR = "https://hf-mirror.com";
const HINT = "If it is blocked where you are, set a mirror in Settings › Models (for example https://hf-mirror.com).";

let prevEnv;
let prevFetch;
beforeEach(() => {
  prevEnv = process.env.HF_ENDPOINT;
  delete process.env.HF_ENDPOINT;
  prevFetch = globalThis.fetch;
  HF.setDefaultHuggingFaceEndpoint(HF.DEFAULT_HF_ENDPOINT);
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.HF_ENDPOINT;
  else process.env.HF_ENDPOINT = prevEnv;
  globalThis.fetch = prevFetch;
  HF.setDefaultHuggingFaceEndpoint(HF.DEFAULT_HF_ENDPOINT);
});

/* ---- the port of huggingface-endpoint.ts ---- */

test("normalize keeps an http(s) origin and refuses the rest, as the agent's parser does", () => {
  assert.equal(HF.normalizeHuggingFaceEndpoint("https://hf-mirror.com/"), MIRROR);
  assert.equal(HF.normalizeHuggingFaceEndpoint("  http://localhost:8080//  "), "http://localhost:8080");
  assert.equal(HF.normalizeHuggingFaceEndpoint("https://proxy.example/hf/"), "https://proxy.example/hf");
  for (const bad of ["hf-mirror.com", "ftp://x", "", "   "]) assert.equal(HF.normalizeHuggingFaceEndpoint(bad), null, bad);
});

test("the default endpoint leaves every URL alone", () => {
  assert.equal(HF.resolveHuggingFaceEndpoint(), "https://huggingface.co");
  assert.equal(HF.rewriteHuggingFaceUrl(CANONICAL), CANONICAL);
  assert.equal(HF.huggingFaceEndpointHost(), "huggingface.co");
});

test("a configured mirror rewrites canonical URLs at request time and nothing else", () => {
  HF.setDefaultHuggingFaceEndpoint("https://hf-mirror.com/");
  assert.equal(HF.rewriteHuggingFaceUrl(CANONICAL), CANONICAL.replace("https://huggingface.co", MIRROR));
  assert.equal(HF.rewriteHuggingFaceUrl("https://hf.co/a/b/resolve/main/x.gguf"), `${MIRROR}/a/b/resolve/main/x.gguf`);
  assert.equal(HF.rewriteHuggingFaceUrl("https://www.huggingface.co/a/b"), `${MIRROR}/a/b`);
  const gh = "https://github.com/ggml-org/llama.cpp/releases/download/b1/x.zip";
  assert.equal(HF.rewriteHuggingFaceUrl(gh), gh);
  assert.equal(HF.huggingFaceEndpointHost(), "hf-mirror.com");
  assert.ok(HF.isHuggingFaceUrl(CANONICAL));
  assert.ok(HF.isHuggingFaceUrl(`${MIRROR}/a/b`));
  assert.ok(!HF.isHuggingFaceUrl(gh));
});

test("stored definitions keep canonical huggingface.co URLs whatever the mirror", () => {
  HF.setDefaultHuggingFaceEndpoint(MIRROR);
  assert.equal(HF.resolveHuggingFaceFileUrl("o/r", "main", "a b.gguf"), "https://huggingface.co/o/r/resolve/main/a%20b.gguf");
  const def = HF.buildCustomModelDef({
    repoId: "o/r", revision: "main",
    file: { path: "m-Q4_K_M.gguf", sizeBytes: 1 << 30 },
    mmproj: { path: "mmproj-F16.gguf", sizeBytes: 1 << 20 },
  });
  assert.ok(def.huggingFaceUrl.startsWith("https://huggingface.co/"), def.huggingFaceUrl);
  assert.ok(def.mmprojUrl.startsWith("https://huggingface.co/"), def.mmprojUrl);
});

test("HF_ENDPOINT wins over the config; an unusable one is ignored", () => {
  HF.setDefaultHuggingFaceEndpoint(MIRROR);
  process.env.HF_ENDPOINT = "https://other.example/";
  assert.equal(HF.resolveHuggingFaceEndpoint(), "https://other.example");
  assert.equal(HF.rewriteHuggingFaceUrl(CANONICAL), CANONICAL.replace("https://huggingface.co", "https://other.example"));
  process.env.HF_ENDPOINT = "not a url";
  assert.equal(HF.resolveHuggingFaceEndpoint(), MIRROR);
});

test("the config value is read from localModels.download.hfEndpoint, the default otherwise", () => {
  assert.equal(HF.huggingFaceEndpointFromConfig({ localModels: { download: { hfEndpoint: "https://hf-mirror.com/" } } }), MIRROR);
  for (const cfg of [null, undefined, {}, { localModels: null }, { localModels: { download: {} } },
    { localModels: { download: { hfEndpoint: 42 } } }, { localModels: { download: { hfEndpoint: "hf-mirror.com" } } }]) {
    assert.equal(HF.huggingFaceEndpointFromConfig(cfg), "https://huggingface.co", JSON.stringify(cfg));
  }
});

/* ---- the unreachable message ---- */

test("an unreachable huggingface.co names the mirror setting; a mirror that is down does not", () => {
  assert.equal(HF.huggingFaceUnreachableMessage("huggingface.co", "fetch failed"), `Could not reach huggingface.co: fetch failed. ${HINT}`);
  assert.equal(HF.huggingFaceUnreachableMessage("huggingface.co", "timed out."), `Could not reach huggingface.co: timed out. ${HINT}`);
  assert.equal(HF.huggingFaceUnreachableMessage("hf-mirror.com", "fetch failed"), "Could not reach hf-mirror.com: fetch failed");
  assert.equal(HF.HF_MIRROR_HINT, HINT);
  assert.ok(!HINT.includes("—"), "no em dash in UI copy");
});

test("the listing asks the active endpoint and says which host it could not reach", async () => {
  const asked = [];
  globalThis.fetch = async (url) => { asked.push(String(url)); throw new TypeError("fetch failed"); };
  await assert.rejects(HF.listHuggingFaceGgufFiles("o/r", "main"), (err) => {
    assert.equal(err.message, `Could not reach huggingface.co: fetch failed. ${HINT}`);
    return true;
  });
  HF.setDefaultHuggingFaceEndpoint(MIRROR);
  await assert.rejects(HF.listHuggingFaceGgufFiles("o/r", "main"), (err) => {
    assert.equal(err.message, "Could not reach hf-mirror.com: fetch failed");
    return true;
  });
  assert.deepEqual(asked, [
    "https://huggingface.co/api/models/o/r/tree/main?recursive=true",
    "https://hf-mirror.com/api/models/o/r/tree/main?recursive=true",
  ]);
});

test("the listing parses what the mirror answers", async () => {
  HF.setDefaultHuggingFaceEndpoint(MIRROR);
  globalThis.fetch = async () => new Response(JSON.stringify([{ path: "m.gguf", lfs: { size: 7 } }, { path: "README.md", size: 1 }]), { status: 200 });
  assert.deepEqual(await HF.listHuggingFaceGgufFiles("o/r"), [{ path: "m.gguf", sizeBytes: 7 }]);
});

test("the projector download goes to the mirror, keeps its token for Hugging Face, and names the host it could not reach", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-mirror-"));
  const prevToken = process.env.HF_TOKEN;
  process.env.HF_TOKEN = "hf_test_token";
  try {
    HF.setDefaultHuggingFaceEndpoint(MIRROR);
    const seen = [];
    globalThis.fetch = async (url, init) => { seen.push({ url: String(url), auth: init.headers.Authorization ?? null }); return new Response("GGUF", { status: 200 }); };
    const dest = join(dir, "mmproj-BF16.gguf");
    await HF.downloadProjector(CANONICAL, dest);
    assert.equal(readFileSync(dest, "utf8"), "GGUF");
    assert.deepEqual(seen, [{ url: CANONICAL.replace("https://huggingface.co", MIRROR), auth: "Bearer hf_test_token" }]);

    globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
    await assert.rejects(HF.downloadProjector(CANONICAL, join(dir, "b.gguf")), { message: "Could not reach hf-mirror.com: fetch failed" });
    HF.setDefaultHuggingFaceEndpoint(HF.DEFAULT_HF_ENDPOINT);
    await assert.rejects(HF.downloadProjector(CANONICAL, join(dir, "c.gguf")), { message: "Could not reach huggingface.co: fetch failed" });
  } finally {
    if (prevToken === undefined) delete process.env.HF_TOKEN; else process.env.HF_TOKEN = prevToken;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analytics counts an unreachable mirror as unreachable, not other", () => {
  assert.equal(C.hfLookupResult(`Could not reach huggingface.co: fetch failed. ${HINT}`), "unreachable");
  assert.equal(C.hfLookupResult("Could not reach hf-mirror.com: fetch failed"), "unreachable");
  assert.equal(C.hfLookupResult("Hugging Face returned 404: no repo or revision by that name."), "not_found");
});

/* ---- the field: main's rule and write ---- */

test("the field's text: empty is the default, an origin is normalised, anything else is refused", () => {
  assert.deepEqual(M.hfMirrorInput(""), { ok: true, value: "https://huggingface.co" });
  assert.deepEqual(M.hfMirrorInput("   "), { ok: true, value: "https://huggingface.co" });
  assert.deepEqual(M.hfMirrorInput(" https://hf-mirror.com/ "), { ok: true, value: MIRROR });
  assert.deepEqual(M.hfMirrorInput("http://10.0.0.5:8080"), { ok: true, value: "http://10.0.0.5:8080" });
  for (const bad of ["hf-mirror.com", "ftp://hf-mirror.com", "https://", "javascript:alert(1)", `https://${"a".repeat(2050)}.com`]) {
    const res = M.hfMirrorInput(bad);
    assert.equal(res.ok, false, bad);
    assert.ok(!res.error.includes("—"), "no em dash in UI copy");
  }
  assert.equal(M.hfMirrorInput(undefined).ok, false);
  assert.equal(M.hfMirrorInput(42).ok, false);
});

test("a save writes localModels.download.hfEndpoint once, and nothing when the text is refused", async () => {
  const writes = [];
  let config = {};
  const deps = {
    sources: () => ({ config, env: undefined, dotenv: undefined }),
    write: async (key, value) => {
      writes.push([key, value]);
      config = { localModels: { download: { hfEndpoint: value } } };
      return { ok: true };
    },
  };
  const saved = await M.writeHfMirror("https://hf-mirror.com/", deps);
  assert.equal(saved.ok, true);
  assert.deepEqual(writes, [["localModels.download.hfEndpoint", MIRROR]]);
  assert.equal(saved.state.configured, MIRROR);
  assert.equal(saved.state.host, "hf-mirror.com");
  assert.equal(HF.resolveHuggingFaceEndpoint(), MIRROR, "pushed in for the next lookup");

  const refused = await M.writeHfMirror("hf-mirror.com", deps);
  assert.equal(refused.ok, false);
  assert.equal(writes.length, 1, "nothing written");

  const cleared = await M.writeHfMirror("", deps);
  assert.equal(cleared.ok, true);
  assert.deepEqual(writes[1], ["localModels.download.hfEndpoint", "https://huggingface.co"]);
  assert.equal(cleared.state.configured, null);
  assert.equal(HF.resolveHuggingFaceEndpoint(), "https://huggingface.co");

  const failing = await M.writeHfMirror(MIRROR, { ...deps, write: async () => ({ ok: false, error: "config set failed: nope" }) });
  assert.deepEqual(failing, { ok: false, error: "config set failed: nope" });
});

test("which endpoint wins: the environment, then the agent's .env, then config.json, then huggingface.co", () => {
  const config = { localModels: { download: { hfEndpoint: MIRROR } } };
  assert.deepEqual(M.hfMirrorState({ config: null, env: undefined, dotenv: undefined }),
    { configured: null, override: null, endpoint: "https://huggingface.co", host: "huggingface.co" });
  assert.deepEqual(M.hfMirrorState({ config, env: undefined, dotenv: undefined }),
    { configured: MIRROR, override: null, endpoint: MIRROR, host: "hf-mirror.com" });
  assert.deepEqual(M.hfMirrorState({ config, env: undefined, dotenv: "https://dot.example" }).override,
    { endpoint: "https://dot.example", from: ".env" });
  const both = M.hfMirrorState({ config, env: "https://env.example/", dotenv: "https://dot.example" });
  assert.deepEqual(both.override, { endpoint: "https://env.example", from: "environment" });
  assert.equal(both.host, "env.example");
  assert.equal(M.hfMirrorState({ config, env: "junk", dotenv: undefined }).endpoint, MIRROR);
  // A set but unusable HF_ENDPOINT still shadows the .env one, as load-dotenv.ts skips it.
  assert.equal(M.hfMirrorState({ config, env: "junk", dotenv: "https://dot.example" }).endpoint, MIRROR);

  // The push-in: a .env value stands where load-dotenv.ts puts it for the CLI.
  M.syncHfEndpoint({ config, env: undefined, dotenv: "https://dot.example" });
  assert.equal(HF.resolveHuggingFaceEndpoint(), "https://dot.example");
  M.syncHfEndpoint({ config, env: undefined, dotenv: undefined });
  assert.equal(HF.resolveHuggingFaceEndpoint(), MIRROR);
});

/* ---- the field: markup ---- */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const h = { esc, ic: (n) => "<i:" + n + ">" };
const IDS = { input: "llm-hf-mirror", save: 'data-act="llm:hf:mirror"' };

test("the field draws its label, its input, its Save and the line under it", () => {
  const html = R.hfMirrorHTML({ state: null, draft: "", error: null, saving: false, saved: false }, h, IDS);
  assert.match(html, /<label class="hfm-lbl" for="llm-hf-mirror">Hugging Face mirror<\/label>/);
  assert.match(html, /<input id="llm-hf-mirror" value=""/);
  assert.match(html, /placeholder="https:\/\/huggingface\.co"/);
  assert.match(html, /data-act="llm:hf:mirror">Save<\/button>/);
  assert.match(html, /Leave it empty to use huggingface\.co\. If it is blocked where you are, try https:\/\/hf-mirror\.com\./);
  assert.ok(!html.includes("—"), "no em dash in UI copy");
});

test("the field escapes what was typed, shows a refusal in red and disables itself while saving", () => {
  const typed = R.hfMirrorHTML({ state: null, draft: '"><img src=x>', error: "Type an address <b>", saving: false }, h, IDS);
  assert.ok(typed.includes('value="&quot;&gt;&lt;img src=x&gt;"'));
  assert.match(typed, /tk-notice--red hfm-err"><i:alert><span class="grow">Type an address &lt;b&gt;<\/span>/);
  const saving = R.hfMirrorHTML({ state: null, draft: MIRROR, saving: true }, h, { input: "ob-hf-mirror", save: 'data-obact="hf:mirror"' });
  assert.match(saving, /<input id="ob-hf-mirror"[^>]* disabled>/);
  assert.match(saving, /data-obact="hf:mirror" disabled>Saving…<\/button>/);
});

test("the line under the field says where models come from, and when HF_ENDPOINT overrides it", () => {
  const configured = { state: { configured: MIRROR, override: null, endpoint: MIRROR, host: "hf-mirror.com" } };
  assert.equal(R.hfMirrorNote(configured), "Models are looked up and downloaded from hf-mirror.com. Leave it empty to use huggingface.co.");
  assert.equal(R.hfMirrorHost(configured), "hf-mirror.com");
  assert.equal(R.hfMirrorHost(null), "huggingface.co");
  const env = { state: { configured: null, override: { endpoint: "https://env.example", from: "environment" }, endpoint: "https://env.example", host: "env.example" } };
  assert.equal(R.hfMirrorNote(env), "HF_ENDPOINT is set in the environment, so models come from env.example whatever this field says.");
  const dot = { state: { ...env.state, override: { endpoint: "https://env.example", from: ".env" } } };
  assert.match(R.hfMirrorNote(dot), /^HF_ENDPOINT is set in the agent’s \.env file/);
  assert.match(R.hfMirrorHTML({ ...configured, saved: true }, h, IDS), /<p class="hfm-note">Saved\. Models are looked up/);
});

test("the window loads the field before renderer.js and asks the active host, not a hardcoded one", () => {
  const index = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  const helper = index.indexOf('<script src="hf-mirror.js">');
  assert.ok(helper > 0 && helper < index.indexOf('<script src="renderer.js">'));
  const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  assert.ok(!source.includes("asking huggingface.co…"), "the busy line names the mirror when one is set");
  assert.equal((source.match(/'asking ' \+ hfMirrorHost\(HFM\) \+ '…'/g) || []).length, 2, "Settings and the wizard");
  assert.match(source, /hfMirrorHTML\(HFM, \{esc, ic\}, \{input:'llm-hf-mirror', save:'data-act="llm:hf:mirror"'\}\)/);
  assert.match(source, /hfMirrorHTML\(HFM, \{esc, ic\}, \{input:'ob-hf-mirror', save:'data-obact="hf:mirror"'\}\)/);
  const acts = readFileSync(new URL("../renderer/analytics-acts.js", import.meta.url), "utf8");
  assert.match(acts, /hf:\{[^}]*mirror:L/);
  const preload = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  assert.match(preload, /hfMirror: \(\) => ipcRenderer\.invoke\("cli:hfMirror"\)/);
  assert.match(preload, /hfMirrorSet: \(value: string\) => ipcRenderer\.invoke\("cli:hfMirrorSet", value\)/);
});
