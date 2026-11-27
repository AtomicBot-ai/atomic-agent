// ATO-2333: Record a meeting, the wiring: the microphone gate, the routes,
// the bridge, the page, the "+" menu row and File › Record a Meeting.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { menuTemplate } = require("../out/main/menu.js");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("the microphone gate opens for a meeting exactly as for voice input, and only audio", () => {
  const main = src("../main/main.ts");
  assert.match(main, /if \(permission !== "media" \|\| !\(voice\.armed \|\| meeting\.armed\)\) return false;/);
  assert.match(main, /types\.every\(\(t\) => t === "audio"\)/, "never the camera");
  assert.match(main, /const meeting = meetingRecorderFor\(transcribeEngine, \(ev\) => send\("app:meeting", ev\)\);/);
  assert.match(main, /const fileTranscriber = new FileTranscriber\(transcribeEngine\);/, "the same engine as Transcribe");
  assert.match(main, /wireMeetingIpc\(meeting\);/);
});

test("the routes stop a recording whose page goes away, and kill it on quit", () => {
  const ipc = src("../main/meeting-ipc.ts");
  for (const ch of ["available", "start", "stop", "status", "finish", "discard", "recoverable", "reveal"]) {
    assert.match(ipc, new RegExp(`ipcMain\\.handle\\("meeting:${ch}"`), ch);
  }
  assert.match(ipc, /ipcMain\.on\("meeting:audio"/);
  assert.match(ipc, /sender\.once\("destroyed", end\)/);
  assert.match(ipc, /app\.on\("will-quit", \(\) => recorder\.kill\(\)\)/);
  assert.match(ipc, /askForMediaAccess\("microphone"\)/);
  assert.match(ipc, /inside\(meetingSaveDir\(\), path\)/, "reveal only shows a saved transcript");
});

test("the bridge, the page and the + menu row", () => {
  const pre = src("../preload/preload.ts");
  assert.match(pre, /meetingStart: \(\) => ipcRenderer\.invoke\("meeting:start"\)/);
  assert.match(pre, /meetingAudio: \(chunk: Uint8Array, peak: number\) => ipcRenderer\.send\("meeting:audio", chunk, peak\)/);
  assert.match(pre, /onMeeting: \(cb: \(payload: unknown\) => void\) => on\("app:meeting", cb\)/);
  const html = src("../renderer/index.html");
  const at = (s) => html.indexOf(s);
  assert.ok(at('src="meeting-logic.js"') > 0 && at('src="meeting-logic.js"') < at('src="meeting-panel.js"'));
  assert.ok(at('src="meeting-panel.js"') < at('src="renderer.js"'));
  assert.ok(at('src="transcribe.js"') < at('src="meeting-panel.js"'));
  assert.match(html, /css\/meeting\.css/);
  assert.match(src("../renderer/attachments.js"), /data-meeting-open="1"/);
  assert.match(src("../renderer/renderer.js"), /if \(k === 'meeting'\) \{ close\(\); render\(\); meetingAct\(v \|\| ''\); return; \}/);
  const panel = src("../renderer/meeting-panel.js");
  assert.match(panel, /class="mtgpill" role="status"/, "the red Recording pill");
  assert.match(panel, /data-mtg="stop"/, "one-click Stop on the pill");
});

for (const platform of ["darwin", "win32", "linux"]) {
  test(`File › Record a Meeting… sends meeting:open (${platform})`, () => {
    const sent = [];
    const file = menuTemplate((c) => sent.push(c), platform).find((m) => m.label === "File");
    const it = file.submenu.find((i) => i.label === "Record a Meeting…");
    assert.ok(it, "the File menu has Record a Meeting…");
    it.click();
    assert.deepEqual(sent, ["meeting:open"]);
  });
}
