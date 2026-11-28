// ATO-2513: "Make your own pet" (renderer/pet-maker-logic.js): which models
// can draw it, the price on the button before anything runs (a local model
// is free, a cloud one says what OpenRouter charges), and the requests.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../renderer/pet-maker-logic.js");
const P = require("../renderer/pet.js");
const { menuTemplate } = require("../out/main/menu.js");

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const catalog = (over = {}) => ({
  local: { models: [
    { id: "flux-s", name: "FLUX schnell", modes: ["create", "reference"], local: { installed: true, defaultQuant: "flux-s-q4" }, aspectRatios: { values: ["1:1", "16:9"] } },
    { id: "not-here", name: "Not downloaded", modes: ["create"], local: { installed: false } },
    { id: "edit-only", name: "Edit only", modes: ["edit"], local: { installed: true } },
  ] },
  cloud: { keyMissing: false, models: [{ id: "google/gemini-img", name: "Gemini image", modes: ["create", "reference"], background: { values: ["transparent"] } }] },
  ...over,
});

test("downloaded local models first, then cloud ones; never one that cannot draw from nothing", () => {
  const opts = M.petmModels(catalog());
  assert.deepEqual(opts.map((o) => [o.provider, o.model, o.free]), [["local", "flux-s-q4", true], ["openrouter", "google/gemini-img", false]]);
  assert.equal(opts[0].ratio, "1:1");
  assert.equal(opts[1].background, "transparent");
  assert.deepEqual(M.petmModels(catalog({ cloud: { keyMissing: true, models: catalog().cloud.models } })).map((o) => o.provider), ["local"], "no key: no cloud models");
  assert.deepEqual(M.petmModels(null), []);
});

test("the price shows before Make: free on this computer, OpenRouter's number when paid", () => {
  const [local, cloud] = M.petmModels(catalog());
  assert.deepEqual(M.petmPrice(local, undefined), { line: "Free: the 4 pictures are made on this computer.", button: "Make my pet", ready: true });
  assert.equal(M.petmPrice(cloud, undefined).ready, false, "the button waits for the price");
  const usd = M.petmPrice(cloud, { usd: 0.16 });
  assert.equal(usd.ready, true);
  assert.match(usd.button, /\$0\.16/);
  assert.match(usd.line, /OpenRouter/);
  assert.match(M.petmPrice(cloud, { usd: 0.1, maxUsd: 0.2 }).line, /\$0\.10.0\.20/);
  assert.match(M.petmPrice(cloud, { perToken: { usdPerMillion: 30 } }).line, /per token/);
  const none = M.petmPrice(cloud, null);
  assert.equal(none.button, "Make my pet (paid)");
  assert.doesNotMatch(none.line, /\$/, "no made-up number");
  assert.equal(M.petmPrice(null, null).ready, false);
});

test("the first picture goes along as the reference when the model takes one", () => {
  const [local] = M.petmModels(catalog());
  const first = M.petmRequest(local, "a tiny robot", "idle", null);
  assert.equal(first.mode, "create");
  assert.equal(first.referenceImages, undefined);
  assert.equal(first.aspectRatio, "1:1");
  assert.match(first.prompt, /a tiny robot/);
  const next = M.petmRequest(local, "a tiny robot", "sleeping", "QUJD");
  assert.equal(next.mode, "reference");
  assert.deepEqual(next.referenceImages, [{ base64: "QUJD" }]);
  assert.match(next.prompt, /same character/i);
  assert.match(next.prompt, /asleep/);
  const noRef = M.petmRequest({ ...local, reference: false }, "x", "working", "QUJD");
  assert.equal(noRef.mode, "create");
});

test("a job's end and the picture it made", () => {
  assert.equal(M.petmJobEnd({ state: "running" }), null);
  assert.equal(M.petmJobEnd({ state: "completed", outputs: [{ path: "/x.png" }] }), "done");
  assert.equal(M.petmJobEnd({ state: "completed", outputs: [] }), "failed");
  assert.equal(M.petmJobEnd({ state: "failed" }), "failed");
  assert.equal(M.petmJobEnd({ state: "cancelled" }), "stopped");
  assert.equal(M.petmDataUrl({ ok: true, data: { dataUrl: "data:image/png;base64,AAAA" } }), "data:image/png;base64,AAAA");
  assert.equal(M.petmDataUrl({ dataUrl: "data:image/webp;base64,AAAA" }), "data:image/webp;base64,AAAA");
  assert.equal(M.petmDataUrl({ dataUrl: "data:text/html;base64,AAAA" }), null);
  assert.equal(M.petmDataUrl({ ok: false, error: "x" }), null);
  assert.equal(M.petmProgressLine(1, "working"), "Making picture 2 of 4: working…");
});

test("the bubble's keys: Enter allows once, Esc denies, a focused other button keeps Enter", () => {
  const model = { allow: true, deny: true };
  assert.equal(P.petBubbleKey("Enter", model, null), "allow");
  assert.equal(P.petBubbleKey("Enter", model, "b-allow"), "allow");
  assert.equal(P.petBubbleKey("Enter", model, "b-deny"), null, "Deny focused: the button answers");
  assert.equal(P.petBubbleKey("Escape", model, "b-allow"), "deny");
  assert.equal(P.petBubbleKey("Escape", { allow: false, deny: false }, null), "hide", "a question: Esc only hides");
  assert.equal(P.petBubbleKey("Enter", { allow: false, deny: true }, null), null, "nothing to allow");
  assert.equal(P.petBubbleKey("a", model, null), null);
  assert.equal(P.petBubbleKey("Enter", null, null), null);
  assert.equal(P.petFirstButton(model), "b-allow");
  assert.equal(P.petFirstButton({ allow: false, deny: true }), "b-deny");
  assert.equal(P.petFirstButton({ allow: false, deny: false }), "b-open");
  assert.equal(P.petKeysLine(true, true, 2), "Enter: Allow once · Esc: Deny · 2 more waiting");
  assert.equal(P.petKeysLine(false, false, 0), "Esc: Hide");
});

test("a made pet's picture for each state; anything but a picture URL is the atom", () => {
  const f = { idle: "data:image/png;base64,I", working: "data:image/png;base64,W", waiting: "data:image/png;base64,A", sleeping: "data:image/png;base64,S" };
  assert.equal(P.petSkinSrc(f, "thinking"), f.working);
  assert.equal(P.petSkinSrc(f, "error"), f.waiting);
  assert.equal(P.petSkinSrc(f, "done"), f.idle);
  assert.equal(P.petSkinSrc({ idle: "https://x/y.png" }, "idle"), null);
  assert.equal(P.petSkinSrc(null, "idle"), null);
});

for (const platform of ["darwin", "win32", "linux"]) {
  test(`View › Desktop Pet › Make Your Own Pet… opens the dialog (${platform})`, () => {
    const sent = [];
    const pet = menuTemplate((c) => sent.push(c), platform).find((m) => m.label === "View").submenu.find((i) => i.label === "Desktop Pet");
    pet.submenu.find((i) => i.label === "Make Your Own Pet…").click();
    assert.deepEqual(sent, ["pet:maker"]);
  });
}

test("the wiring: main opens the maker, preload names the routes, the pages load the scripts", () => {
  assert.match(read("../main/main.ts"), /command === "pet:maker"\) \{ petHub\?\.openMaker\(\)/);
  const preload = read("../preload/preload.ts");
  for (const ch of ["pet:focus", "pet:skinGet", "pet:skins", "pet:saveSkin", "pet:useSkin", "pet:deleteSkin"]) assert.ok(preload.includes(`"${ch}"`), ch);
  const ipc = read("../main/pet-skins-ipc.ts");
  for (const ch of ["pet:skinGet", "pet:skins", "pet:saveSkin", "pet:useSkin", "pet:deleteSkin"]) assert.ok(ipc.includes(`ipcMain.handle("${ch}"`), ch);
  const index = read("../renderer/index.html");
  assert.ok(index.indexOf("pet-maker-logic.js") < index.indexOf("pet-maker.js\""), "logic before the dialog");
  assert.match(index, /id="pet-maker"/);
  assert.match(read("../renderer/pet.html"), /img-src data:/);
});
