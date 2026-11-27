// ATO-2383: "Save as app" on an artifact card and Settings › My apps
// (renderer/my-apps.js), and their hooks in chat-artifact.js and renderer.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const calls = [];
globalThis.window = {
  atomic: {
    artifactPut: async () => ({ ok: true, url: "atomic-art://" + "0".repeat(32) + "/" }),
    artifactDrop: async () => ({ ok: true }),
    filePreview: async () => ({ ok: false }),
  },
};
globalThis.BR = {
  appsList: async () => { calls.push(["list"]); return { ok: true, apps: [] }; },
  appsSave: async (input) => { calls.push(["save", input]); return { ok: true, app: { id: "tip-aaaaaa", name: input.name, createdAt: "2026-11-27T10:00:00Z" } }; },
  appsOpen: async (id) => { calls.push(["open", id]); return { ok: true }; },
  appsRename: async (id, name) => { calls.push(["rename", id, name]); return { ok: true, app: { id, name } }; },
  appsDelete: async (id) => { calls.push(["delete", id]); return { ok: true }; },
};
globalThis.S = { settings: 0, settingsPane: "general", sessionId: "chat-7" };
const toasts = [];
globalThis.toast = (t, s, kind) => toasts.push({ t, s, kind });
globalThis.esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
globalThis.ic = (n) => "<i:" + n + ">";

const ART = require("../renderer/chat-artifact.js");
const M = require("../renderer/my-apps.js");
globalThis.CHAT_ART = ART.CHAT_ART;
globalThis.myAppsSaveButtonHTML = M.myAppsSaveButtonHTML;
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await tick(); }
}

test("a shown artifact's bar has Save as app; a loading one does not", async () => {
  const st = ART.chatArtifactSet("code:hsave1", "<p>tip</p>", { title: "Tip calc" });
  assert.doesNotMatch(ART.chatArtifactSlotHTML("code:hsave1") || "", /Save as app/);
  await until(() => st.state === "ok");
  const html = ART.chatArtifactSlotHTML("code:hsave1");
  assert.match(html, /data-act="myapps:save:code:hsave1"/);
  assert.match(html, /Save as app/);
});

test("the save sends the page on screen, its title and the chat it came from", async () => {
  assert.deepEqual(M.maSaveInput("code:hsave1", ART.CHAT_ART, "chat-7"), { name: "Tip calc", html: "<p>tip</p>", chatId: "chat-7" });
  assert.equal(M.maSaveInput("nope", ART.CHAT_ART, "chat-7"), null);
  assert.deepEqual(M.maSaveInput("code:hsave1", ART.CHAT_ART, ""), { name: "Tip calc", html: "<p>tip</p>" });
  M.myAppsAct("save:code:hsave1");
  await until(() => toasts.length > 0);
  assert.deepEqual(calls.find((c) => c[0] === "save"), ["save", { name: "Tip calc", html: "<p>tip</p>", chatId: "chat-7" }]);
  assert.equal(toasts[0].t, "Saved to My apps");
  assert.equal(M.MA.saving, null);
});

test("verbs keep the artifact key's colons; app verbs take only a slug id", async () => {
  assert.deepEqual(M.maParseAct("save:canvas:s1:sales"), { verb: "save", arg: "canvas:s1:sales" });
  assert.deepEqual(M.maParseAct("refresh"), { verb: "refresh", arg: "" });
  M.myAppsAct('open:x"]; alert(1)');
  M.myAppsAct("open:tip-aaaaaa");
  await until(() => calls.some((c) => c[0] === "open"));
  assert.deepEqual(calls.filter((c) => c[0] === "open"), [["open", "tip-aaaaaa"]]);
});

test("the list draws Open, Rename and Delete per app, and an empty state", () => {
  M.MA.apps = [];
  assert.match(M.myAppsTab(), /No apps yet/);
  M.MA.apps = [{ id: "tip-aaaaaa", name: "Tip <calc>", createdAt: "2026-11-27T10:00:00Z" }];
  const html = M.myAppsTab();
  assert.match(html, /Tip &lt;calc&gt;/);
  for (const v of ["open", "rename", "delete"]) assert.match(html, new RegExp('data-act="myapps:' + v + ':tip-aaaaaa"'));
  M.MA.confirm = "tip-aaaaaa";
  assert.match(M.myAppsTab(), /data-act="myapps:deleteConfirm:tip-aaaaaa"/);
  M.MA.confirm = null;
  assert.match(M.maSavedText({ createdAt: "2026-11-27T10:00:00Z" }, "en-GB"), /^Saved 27 Nov 2026$/);
  assert.equal(M.maReasonText("too-large"), "This page is larger than 4 MB, too large to keep as an app.");
});

test("renderer.js has the Settings section and routes the verbs", () => {
  const r = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  assert.match(r, /\['myapps','My apps','window',\['myapps'\]\],/);
  assert.match(r, /else if \(pane === 'myapps'\) myAppsTabEntered\(\);/);
  assert.match(r, /if \(p === 'myapps'\) return myAppsTab\(\);/);
  assert.match(r, /if \(k === 'myapps'\) \{ close\(\); myAppsAct\(a\.slice\(7\)\); return; \}/);
  const idx = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.ok(idx.indexOf('<script src="my-apps.js"></script>') < idx.indexOf('<script src="renderer.js"></script>'));
});
