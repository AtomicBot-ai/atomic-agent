// ATO-2744: privacy:open, one whitelisted macOS Privacy pane (main/privacy-pane.ts),
// against the built output (npm run build first), plus its wiring pins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../out/main/privacy-pane.js");
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("only Full Disk Access and Input Monitoring, only on macOS", () => {
  assert.equal(P.privacyPaneUrl("fullDiskAccess", "darwin"), "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
  assert.equal(P.privacyPaneUrl("inputMonitoring", "darwin"), "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent");
  for (const bad of ["Privacy_Accessibility", "accessibility", "camera", "toString", "__proto__", "", null, 7, "x-apple.systempreferences:x"]) {
    assert.equal(P.privacyPaneUrl(bad, "darwin"), null, String(bad));
  }
  for (const platform of ["win32", "linux"]) assert.equal(P.privacyPaneUrl("fullDiskAccess", platform), null, platform);
});

test("open: the mapped URL goes to openExternal; anything else never reaches it", async () => {
  const opened = [];
  const deps = { openExternal: async (u) => { opened.push(u); }, platform: "darwin" };
  assert.deepEqual(await P.openPrivacyPane(deps, "inputMonitoring"), { ok: true });
  assert.equal((await P.openPrivacyPane(deps, "https://example.com")).ok, false);
  assert.equal((await P.openPrivacyPane({ ...deps, platform: "win32" }, "fullDiskAccess")).ok, false);
  assert.equal((await P.openPrivacyPane({ ...deps, platform: "linux" }, "inputMonitoring")).ok, false);
  assert.deepEqual(opened, ["x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"]);
  const fails = await P.openPrivacyPane({ openExternal: async () => { throw new Error("no handler"); }, platform: "darwin" }, "fullDiskAccess");
  assert.equal(fails.ok, false);
  assert.ok(!/no handler/.test(fails.error), "a sentence, not the raw error");
});

test("hooks: registered from show-once-ipc.ts, exposed in preload", () => {
  const handlers = new Map();
  P.registerPrivacyPaneIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, openExternal: async () => {}, platform: "darwin" });
  assert.ok(handlers.has("privacy:open"));
  const ipc = read("../main/show-once-ipc.ts");
  assert.match(ipc, /import \{ registerPrivacyPaneIpc \} from "\.\/privacy-pane\.js";/);
  assert.match(ipc, /registerPrivacyPaneIpc\(\{ ipcMain, openExternal: \(url\) => shell\.openExternal\(url\), platform: process\.platform \}\);/);
  assert.match(read("../preload/preload.ts"), /privacyOpen: \(pane: "fullDiskAccess" \| "inputMonitoring"\) => ipcRenderer\.invoke\("privacy:open", pane\)/);
});
