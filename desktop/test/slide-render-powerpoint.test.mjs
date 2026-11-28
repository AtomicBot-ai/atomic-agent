// ATO-2517 (review of #2111): PowerPoint on Windows is quit only when we
// started it, and a run that fails or hits its time limit (Node ends
// powershell.exe, so its `finally` never runs; POWERPNT.EXE is a COM server,
// not its child) is cleaned up by a second script, and as a last resort the
// PowerPoint we started is ended. Tested against the built output (npm run
// build) with a stub `run` that plays PowerShell; throwaway folders only.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const {
  powerPointScript, powerPointCleanupScript, powerPointKillScript, powerPointState, powerPointPlan, powerPointCleanupPlan,
  POWERPOINT_TIMEOUT_MS, POWERPOINT_CLEANUP_TIMEOUT_MS, POWERPOINT_KILL_TIMEOUT_MS,
} = require("../out/main/slide-render-powerpoint.js");
const { renderSlides } = require("../out/main/slide-render.js");

const home = mkdtempSync(join(tmpdir(), "pp-home-"));
const tmp = mkdtempSync(join(tmpdir(), "pp-tmp-"));
after(() => { for (const d of [home, tmp]) rmSync(d, { recursive: true, force: true }); });

function storedZip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8"), nm = Buffer.from(name, "utf8"), crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, data); centrals.push(ch, nm);
    off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  const count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
let n = 0;
function deck() {
  const p = join(home, `deck${++n}.pptx`);
  writeFileSync(p, storedZip({ "ppt/slides/slide1.xml": "<p:sld/>",
    "ppt/slides/_rels/slide1.xml.rels": '<Relationships><Relationship Id="r" Type="x/image" Target="../media/a.png"/></Relationships>' }));
  return p;
}
const PATHS = { deck: "C:\\d.pptx", copy: "C:\\o\\deck.pptx", pdf: "C:\\o\\slides.pdf", state: "C:\\o\\powerpoint-state.txt" };
const scriptOf = (args) => Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
const stateOf = (script) => /Set-Content -LiteralPath '((?:[^']|'')*)'/.exec(script)[1].replace(/''/g, "'");
const WIN = { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" };
const winDeps = (run) => ({ env: WIN, home, tmp, exists: (p) => p.endsWith("POWERPNT.EXE") || p.endsWith("powershell.exe"), run });
/**
 * What the cleanup script exits with when GetActiveObject throws (no PowerPoint to attach to), read
 * from the script's own catch: `exit N`, or `if ($s[0] -eq 'X') { exit N }` checked against the state.
 */
function cleanupExitWhenNotAttached(script, stateText) {
  const m = /GetActiveObject\('PowerPoint\.Application'\) \} catch \{ ([^\n]*) \}$/m.exec(script);
  assert.ok(m, "the cleanup attaches inside a try/catch");
  const first = String(stateText).split(/\r?\n/)[0];
  for (const part of m[1].split(";").map((x) => x.trim())) {
    const cond = /^if \(\$s\[0\] -eq '([01])'\) \{ exit (\d+) \}$/.exec(part);
    if (cond) { if (first === cond[1]) return Number(cond[2]); continue; }
    const plain = /^exit (\d+)$/.exec(part);
    if (plain) return Number(plain[1]);
    assert.fail(`unexpected catch step: ${part}`);
  }
  return 0;
}
/**
 * A stub PowerShell: `main` plays the first script (and may write its state file), the others answer `cleanup` / `kill`.
 * `cleanup: "no-attach"` plays a PowerPoint not in the ROT: the cleanup's own catch decides its exit code.
 */
function playPowerShell({ state, cleanup = false }) {
  const calls = [];
  const run = async (_command, args, timeoutMs) => {
    const script = scriptOf(args);
    const kind = script.includes("Presentations.Open") ? "main" : script.includes("GetActiveObject") ? "cleanup" : script.includes("Stop-Process") ? "kill" : "?";
    calls.push({ kind, script, timeoutMs });
    if (kind === "main") { if (state) writeFileSync(stateOf(script), state); return { ok: false }; }   // ended by its time limit
    if (kind === "cleanup" && cleanup === "no-attach") return { ok: cleanupExitWhenNotAttached(script, state) === 0 };
    return { ok: kind === "cleanup" ? cleanup : true };
  };
  return { calls, run };
}

test("a PowerPoint that was already running is never quit, not even on its start screen", () => {
  const script = powerPointScript(PATHS);
  const check = script.indexOf("$wasRunning = @(Get-Process -Name POWERPNT");
  assert.ok(check >= 0 && check < script.indexOf("New-Object -ComObject PowerPoint.Application"), "checked before New-Object attaches to it");
  assert.match(script, /if \(-not \$wasRunning -and \$app\.Presentations\.Count -eq 0\) \{ \$app\.Quit\(\) \}/);
  assert.doesNotMatch(script.replace(/if \(-not \$wasRunning -and [^\n]*Quit\(\) \}/, ""), /Quit\(\)/, "no other Quit");
  assert.ok(script.indexOf("Set-Content") < script.indexOf("New-Object"), "the state is on disk before PowerPoint is asked for");
  assert.match(script, /\$app\.AutomationSecurity = 3/, "no macros while the copy is open");
  assert.match(script, /\$app\.AutomationSecurity = \$security/, "and the setting is put back");
  const cleanup = powerPointCleanupScript(PATHS);
  assert.match(cleanup, /GetActiveObject\('PowerPoint\.Application'\)/, "attaches, never starts one");
  assert.match(cleanup, /if \(\$s\[0\] -eq '0' -and \$app\.Presentations\.Count -eq 0\) \{ \$app\.Quit\(\) \}/);
  assert.match(cleanup, /\$d\.Name -eq \$name -and \(Split-Path -Leaf \$d\.Path\) -eq \$dir\) \{ \$d\.Close\(\) \}/, "only our copy is closed");
});

test("the state file and the kill: only a PowerPoint we started, by its start time", () => {
  assert.deepEqual(powerPointState("0\r\n638700000000000000\r\n1\r\n1\r\n"), { wasRunning: false, since: "638700000000000000" });
  assert.deepEqual(powerPointState("1\r\n638700000000000000\r\n"), { wasRunning: true, since: "638700000000000000" }, "written before PowerPoint started");
  assert.equal(powerPointState(null), null);
  assert.equal(powerPointState("0\r\n"), null);
  assert.equal(powerPointState("0\r\n1; Stop-Computer\r\n"), null, "only digits reach a script");
  assert.equal(powerPointKillScript({ wasRunning: true, since: "638700000000000000" }), null, "the person's own PowerPoint is never ended");
  assert.equal(powerPointKillScript(null), null);
  const kill = powerPointKillScript({ wasRunning: false, since: "638700000000000000" });
  assert.match(kill, /Get-Process -Name POWERPNT/);
  assert.match(kill, /StartTime\.ToUniversalTime\(\)\.Ticks -ge 638700000000000000/);
  assert.match(kill, /SessionId -eq \(Get-Process -Id \$PID\)\.SessionId/, "this session only");
  assert.ok(POWERPOINT_CLEANUP_TIMEOUT_MS + POWERPOINT_KILL_TIMEOUT_MS < POWERPOINT_TIMEOUT_MS, "the cleanup is short next to the run");
  assert.equal(powerPointPlan("C:\\ps.exe", PATHS).timeoutMs, POWERPOINT_TIMEOUT_MS);
  assert.equal(powerPointCleanupPlan("C:\\ps.exe", PATHS).timeoutMs, POWERPOINT_CLEANUP_TIMEOUT_MS);
});

test("a run ended by its time limit is cleaned up; a hung PowerPoint we started is ended", async () => {
  const s = playPowerShell({ state: "0\r\n638700000000000000\r\n1\r\n1\r\n", cleanup: false });
  assert.equal(await renderSlides(deck(), "win32", winDeps(s.run)), null);
  assert.deepEqual(s.calls.map((c) => c.kind), ["main", "cleanup", "kill"]);
  assert.match(s.calls[2].script, /-ge 638700000000000000/);
});

test("a PowerPoint we started that the cleanup cannot attach to (hung in start-up) is still ended", async () => {
  // Round-2 review: the cleanup's catch used to `exit 0`, so a POWERPNT hung before it registered was never killed.
  const hung = playPowerShell({ state: "0\r\n638700000000000000\r\n1\r\n1\r\n", cleanup: "no-attach" });
  assert.equal(await renderSlides(deck(), "win32", winDeps(hung.run)), null);
  assert.deepEqual(hung.calls.map((c) => c.kind), ["main", "cleanup", "kill"]);
  assert.match(hung.calls[2].script, /-ge 638700000000000000/);
  const theirs = playPowerShell({ state: "1\r\n638700000000000000\r\n1\r\n1\r\n", cleanup: "no-attach" });
  await renderSlides(deck(), "win32", winDeps(theirs.run));
  assert.deepEqual(theirs.calls.map((c) => c.kind), ["main", "cleanup"], "the person's own PowerPoint: nothing to end");
  assert.equal(cleanupExitWhenNotAttached(powerPointCleanupScript(PATHS), "0\r\n1\r\n"), 1);
  assert.equal(cleanupExitWhenNotAttached(powerPointCleanupScript(PATHS), "1\r\n1\r\n"), 0);
});

test("a cleanup that worked needs no kill; the person's own PowerPoint is never ended", async () => {
  const ok = playPowerShell({ state: "0\r\n638700000000000000\r\n1\r\n1\r\n", cleanup: true });
  await renderSlides(deck(), "win32", winDeps(ok.run));
  assert.deepEqual(ok.calls.map((c) => c.kind), ["main", "cleanup"]);
  const theirs = playPowerShell({ state: "1\r\n638700000000000000\r\n1\r\n1\r\n", cleanup: false });
  await renderSlides(deck(), "win32", winDeps(theirs.run));
  assert.deepEqual(theirs.calls.map((c) => c.kind), ["main", "cleanup"], "already running: no kill");
  const never = playPowerShell({ state: null, cleanup: false });
  await renderSlides(deck(), "win32", winDeps(never.run));
  assert.deepEqual(never.calls.map((c) => c.kind), ["main", "cleanup"], "no state file: the script never got to PowerPoint");
});
