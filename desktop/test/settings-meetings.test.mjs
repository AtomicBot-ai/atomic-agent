// ATO-2514: Settings, Meetings (renderer/settings-meetings.js) and its hooks.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const NAME = "Meeting 2026-11-27 14-05 transcript.txt";
const calls = [];
globalThis.BR = {
  meetingSettingsGet: async () => ({ ok: true, prefs: { folder: null, systemAudio: true, voices: true }, folder: "/Users/x/Documents/Atomic Agent/Meetings", defaultFolder: "/Users/x/Documents/Atomic Agent/Meetings" }),
  meetingSettingsSet: async (p) => { calls.push(["set", p]); return { ok: true, prefs: { folder: null, systemAudio: p.systemAudio ?? true, voices: true }, folder: "/f", defaultFolder: "/f" }; },
  meetingList: async () => ({ ok: true, items: [{ name: NAME, startedAt: new Date(2026, 10, 27, 14, 5).getTime(), bytes: 12_400, notes: NAME.replace(".txt", ".notes.md") }] }),
  meetingTrash: async (n) => { calls.push(["trash", n]); return { ok: false, error: "trash-failed" }; },
  meetingVoicesStatus: async () => ({ known: true, supported: true, installed: false, downloadBytes: 56_000_000, enabled: true, downloading: false }),
};
globalThis.S = { settings: 0, settingsPane: "general" };
const toasts = [];
globalThis.toast = (t, s, kind) => toasts.push({ t, s, kind });
globalThis.esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
globalThis.ic = (n) => "<i:" + n + ">";
globalThis.setSwitchHTML = (o) => '<button role="switch" aria-checked="' + !!o.on + '" data-act="' + o.act + '"></button>';

const M = require("../renderer/settings-meetings.js");
const tick = () => new Promise((r) => setTimeout(r, 0));

test("the speaker model line states size and licences before the download", () => {
  const t = M.msVoicesText({ known: true, supported: true, installed: false, downloadBytes: 56_000_000 }, null);
  assert.match(t, /about 56 MB/);
  assert.match(t, /Apache-2\.0/);
  assert.match(t, /MIT/);
  assert.equal(M.msVoicesText(null, 0.42), "Downloading the speaker model, 42%.");
  assert.match(M.msVoicesText({ known: false }, null), /newer Atomic Agent/);
  assert.match(M.msVoicesText({ known: true, supported: false }, null), /Not available on this computer/);
});

test("titles and sizes are plain words", () => {
  assert.match(M.msTitle({ name: NAME, startedAt: new Date(2026, 10, 27, 14, 5).getTime() }, "en-GB"), /^Meeting, 27 Nov 2026/);
  assert.equal(M.msTitle({ name: "odd", startedAt: NaN }), "odd");
  assert.equal(M.msSizeText(12_400), "12 KB");
  assert.equal(M.msSizeText(1_500_000), "1.4 MB");
  assert.deepEqual(M.msParseAct("open:" + NAME), { verb: "open", arg: NAME });
});

test("Delete asks first, and a failed delete keeps the row and says so in red", async () => {
  M.meetingsTabEntered();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(M.MS.items.length, 1);
  assert.match(M.meetingsTab(), new RegExp('data-act="meetings:delete:' + NAME + '"'));
  M.meetingsAct("delete:" + NAME);
  const html = M.meetingsTab();
  assert.match(html, /Move it and its notes to the Trash\?/);
  assert.equal(calls.filter((c) => c[0] === "trash").length, 0, "nothing is deleted on the first click");
  M.meetingsAct("deleteConfirm:" + NAME);
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(calls.find((c) => c[0] === "trash"), ["trash", NAME]);
  assert.equal(M.MS.items.length, 1);
  assert.equal(toasts.at(-1).kind, "bad");
  assert.doesNotMatch(toasts.at(-1).s, /trash-failed|\//);
});

test("a switch writes its own setting", async () => {
  M.meetingsAct("systemAudio");
  for (let i = 0; i < 3; i++) await tick();
  assert.deepEqual(calls.find((c) => c[0] === "set"), ["set", { systemAudio: false }]);
});

test("wiring: the pane's hooks in renderer.js, the script before renderer.js, routes and preload", () => {
  const r = src("../renderer/renderer.js");
  assert.match(r, /\['meetings','Meetings','mic',\['meetings'\]\],/);
  assert.match(r, /else if \(pane === 'meetings'\) meetingsTabEntered\(\);/);
  assert.match(r, /if \(p === 'meetings'\) return meetingsTab\(\);/);
  assert.match(r, /if \(k === 'meetings'\) \{ close\(\); meetingsAct\(a\.slice\(9\)\); return; \}/);
  assert.match(r, /\['meetings','Meetings'\]\);/);
  const html = src("../renderer/index.html");
  const at = html.indexOf('src="settings-meetings.js"');
  assert.ok(at > 0 && at < html.indexOf('src="renderer.js"'));
  assert.match(src("../main/main.ts"), /wireMeetingLibraryIpc\(\);/);
  const ipc = src("../main/meeting-library-ipc.ts");
  for (const ch of ["settings-get", "settings-set", "choose-folder", "list", "open", "show", "trash"]) assert.match(ipc, new RegExp(`ipcMain\\.handle\\("meeting:${ch}"`), ch);
  assert.match(ipc, /shell\.trashItem\(path\)/);
  const pre = src("../preload/preload.ts");
  for (const m of ["meetingSettingsGet", "meetingSettingsSet", "meetingChooseFolder", "meetingList", "meetingOpen", "meetingShow", "meetingTrash"]) assert.match(pre, new RegExp(`${m}: \\(`), m);
  // The saved folder is what the recorder writes to, and the switch is what system audio reads.
  assert.match(src("../main/meeting-ipc.ts"), /readMeetingPrefs\(app\.getPath\("userData"\)\)\.folder \?\? meetingDefaultDir\(\)/);
  assert.match(src("../main/meeting-system-ipc.ts"), /readMeetingPrefs\(app\.getPath\("userData"\)\)\.systemAudio/);
});

test("Delete when the notes cannot be moved: the row goes, and a red line says the notes stayed", async () => {
  const before = globalThis.BR.meetingTrash;
  globalThis.BR.meetingTrash = async (n) => { calls.push(["trash", n]); return { ok: false, error: "notes-trash-failed" }; };
  try {
    M.meetingsTabEntered();
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(M.MS.items.length, 1);
    M.meetingsAct("delete:" + NAME);
    M.meetingsAct("deleteConfirm:" + NAME);
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(M.MS.items.length, 0, "the transcript is in the Trash");
    assert.equal(toasts.at(-1).kind, "bad");
    assert.match(M.MS.err, /notes could not be/);
    assert.equal(M.MS.msg, null, "no 'and its notes were moved' line");
  } finally {
    globalThis.BR.meetingTrash = before;
  }
});

test("the speaker model can be removed, or downloaded from the offer, with the switch off", async () => {
  const prefs = M.MS.prefs, voices = M.MS.voices;
  try {
    M.MS.busy = null; M.MS.download = null;
    M.MS.prefs = { folder: null, systemAudio: true, voices: false };
    M.MS.voices = { known: true, supported: true, installed: true };
    assert.match(M.meetingsTab(), /data-act="meetings:voicesRemove"/);
    M.MS.voices = { known: true, supported: true, installed: false, downloadBytes: 56_000_000 };
    assert.match(M.meetingsTab(), /data-act="meetings:voicesGet"/);
    let installs = 0;
    globalThis.BR.meetingVoicesInstall = async () => { installs++; return { ok: true }; };
    calls.length = 0;
    M.meetingsAct("voicesGet");
    for (let i = 0; i < 3; i++) await tick();
    assert.equal(installs, 1);
    assert.deepEqual(calls.find((c) => c[0] === "set"), ["set", { voices: true }], "Download turns the switch on");
  } finally {
    delete globalThis.BR.meetingVoicesInstall;
    M.MS.prefs = prefs; M.MS.voices = voices; M.MS.download = null;
  }
});
