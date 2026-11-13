// ATO-526: Settings > Skills says whether each skill's external programs
// (gh, docker, icalBuddy…) are on this computer, with the skill's own
// install line. Main looks the names up on the agent's PATH with each
// platform's rules (main/skill-bins.ts, against the built output: npm run
// build first); the renderer only words it (renderer/skill-bins.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const {
  pathDirs, binFileNames, findBin, entryAvailable, installHintFor, skillBinsStatus,
  createBinCache, withSkillBins, envPath, fsIsExecutable,
} = require("../out/main/skill-bins.js");
const { skillBinsNames, skillBinsSummary, skillBinsRowHTML, skillBinsDetailHTML } = require("../renderer/skill-bins.js");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fakeFs = (files) => (file) => files.includes(file);

test("macOS/Linux: PATH splits on ':', relative and empty entries are skipped", () => {
  assert.deepEqual(pathDirs("/usr/bin::bin:./x:/opt/homebrew/bin", "darwin"), ["/usr/bin", "/opt/homebrew/bin"]);
  assert.deepEqual(pathDirs(undefined, "linux"), []);
});

test("Windows: PATH splits on ';', quoted folders are unquoted, PATHEXT names are tried", () => {
  assert.deepEqual(pathDirs('C:\\Windows\\system32;"C:\\Program Files\\GitHub CLI";;rel', "win32"),
    ["C:\\Windows\\system32", "C:\\Program Files\\GitHub CLI"]);
  assert.deepEqual(binFileNames("gh", "win32", ".EXE;.CMD"), ["gh.exe", "gh.cmd"]);
  assert.deepEqual(binFileNames("gh.exe", "win32", ".EXE;.CMD"), ["gh.exe"]);
  assert.deepEqual(binFileNames("gh", "win32"), ["gh.com", "gh.exe", "gh.bat", "gh.cmd"]);
  assert.deepEqual(binFileNames("gh", "darwin", ".EXE"), ["gh"]);
  const lookup = { platform: "win32", path: 'C:\\Windows;"C:\\Program Files\\GitHub CLI"', pathext: ".EXE;.CMD",
    isExecutable: fakeFs(["C:\\Program Files\\GitHub CLI\\gh.exe"]) };
  assert.equal(findBin("gh", lookup), "C:\\Program Files\\GitHub CLI\\gh.exe");
});

test("the first folder on PATH wins, and a missing program is null", () => {
  const lookup = { platform: "darwin", path: "/usr/bin:/opt/homebrew/bin:/usr/local/bin",
    isExecutable: fakeFs(["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) };
  assert.equal(findBin("gh", lookup), "/opt/homebrew/bin/gh");
  assert.equal(findBin("icalBuddy", lookup), null);
});

test("only a bare program name is looked up: no paths, no shell words", () => {
  const seen = [];
  const lookup = { platform: "linux", path: "/usr/bin", isExecutable: (f) => (seen.push(f), true) };
  for (const bad of ["../bin/sh", "/bin/sh", "gh;rm", "a b", "", "-x"]) assert.equal(findBin(bad, lookup), null, bad);
  assert.deepEqual(seen, []);
});

test("an entry with alternatives is met by any one of them", () => {
  const lookup = { platform: "linux", path: "/usr/bin", isExecutable: fakeFs(["/usr/bin/convert"]) };
  assert.equal(entryAvailable("magick|convert", lookup), true);
  assert.equal(entryAvailable("magick", lookup), false);
});

test("the install line is the skill's own for this platform, else its any-platform one, else none", () => {
  const hints = { darwin: "brew install gh", any: "see https://cli.github.com" };
  assert.equal(installHintFor(hints, "darwin"), "brew install gh");
  assert.equal(installHintFor(hints, "win32"), "see https://cli.github.com");
  assert.equal(installHintFor({ darwin: "brew install gh" }, "linux"), null);
  assert.equal(installHintFor(undefined, "darwin"), null);
  assert.equal(installHintFor(["brew"], "darwin"), null);
});

test("a row's status lists what is missing; a row that names no programs gets none", () => {
  const lookup = { platform: "darwin", path: "/opt/homebrew/bin", isExecutable: fakeFs(["/opt/homebrew/bin/ffmpeg"]) };
  assert.deepEqual(skillBinsStatus({ requiresBins: ["ffmpeg", "ffprobe"], installHints: { darwin: "brew install ffmpeg" } }, lookup),
    { required: ["ffmpeg", "ffprobe"], missing: ["ffprobe"], installHint: "brew install ffmpeg" });
  assert.equal(skillBinsStatus({}, lookup), null);
  assert.equal(skillBinsStatus({ requiresBins: [] }, lookup), null);
  assert.equal(skillBinsStatus({ requiresBins: ["/bin/sh", 3] }, lookup), null);
  const rows = withSkillBins([{ name: "a", requiresBins: ["ffmpeg"] }, { name: "b" }], lookup);
  assert.deepEqual(rows[0].bins, { required: ["ffmpeg"], missing: [], installHint: null });
  assert.equal("bins" in rows[1], false);
});

test("the cache keeps a found program for the full time, a missing one only briefly", () => {
  let t = 0, calls = 0;
  const files = [];
  const lookup = { platform: "darwin", path: "/opt/homebrew/bin", isExecutable: (f) => (calls++, files.includes(f)) };
  const cache = createBinCache(30_000, () => t);
  assert.equal(cache.find("gh", lookup), null);
  files.push("/opt/homebrew/bin/gh");               // the person runs brew install gh
  t = 1_000; assert.equal(cache.find("gh", lookup), null, "a miss is kept for a moment");
  t = 3_500; assert.equal(cache.find("gh", lookup), "/opt/homebrew/bin/gh", "and looked up again after it");
  const before = calls;
  t = 20_000; assert.equal(cache.find("gh", lookup), "/opt/homebrew/bin/gh");
  assert.equal(calls, before, "a found program is not looked up again within the time");
  const other = { ...lookup, path: "/usr/bin" };
  assert.equal(cache.find("gh", other), null, "another PATH is its own entry");
});

test("PATH comes from a spread env whatever its case on Windows", () => {
  assert.equal(envPath({ Path: "C:\\x" }, "win32"), "C:\\x");
  assert.equal(envPath({ PATH: "/usr/bin" }, "darwin"), "/usr/bin");
  assert.equal(envPath({ Path: "/usr/bin" }, "darwin"), undefined);
});

test("a real executable is found, a plain file and a folder are not", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-bins-"));
  try {
    writeFileSync(join(dir, "tool"), "#!/bin/sh\n"); chmodSync(join(dir, "tool"), 0o755);
    writeFileSync(join(dir, "plain"), "x"); chmodSync(join(dir, "plain"), 0o644);
    mkdirSync(join(dir, "folder"));
    const lookup = { platform: process.platform, path: dir, isExecutable: fsIsExecutable(process.platform) };
    assert.equal(findBin("tool", lookup), join(dir, "tool"));
    assert.equal(findBin("plain", lookup), null);
    assert.equal(findBin("folder", lookup), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the words: a quiet line when all are found, the missing names and install line otherwise", () => {
  assert.equal(skillBinsNames(["a"]), "a");
  assert.equal(skillBinsNames(["a", "b", "magick|convert"]), "a, b and magick or convert");
  assert.equal(skillBinsSummary(null), null);
  assert.equal(skillBinsSummary({ required: [], missing: [] }), null);
  assert.deepEqual(skillBinsSummary({ required: ["gh"], missing: [], installHint: "brew install gh" }),
    { tone: "ok", text: "gh found on this computer", hint: null });
  assert.deepEqual(skillBinsSummary({ required: ["gh"], missing: ["gh"], installHint: "brew install gh" }),
    { tone: "miss", text: "Needs program gh, not found", hint: "brew install gh" });
  assert.equal(skillBinsSummary({ required: ["a", "b"], missing: ["a", "b"], installHint: null }).text, "Needs programs a and b, not found");
});

test("the row and detail HTML escape the skill's own text and never invent a package name", () => {
  const row = skillBinsRowHTML({ required: ["gh"], missing: ["gh"], installHint: "brew install <gh>" }, esc);
  assert.match(row, /set-skbins--miss/);
  assert.match(row, /Install: <span class="mono">brew install &lt;gh&gt;<\/span>/);
  const noHint = skillBinsDetailHTML({ required: ["memo"], missing: ["memo"], installHint: null }, esc);
  assert.equal(noHint, '<p class="set-cap set-skbins set-skbins--miss">Needs program memo, not found. Install it, then press r to check again.</p>');
  assert.doesNotMatch(noHint, /brew/);
  assert.match(skillBinsDetailHTML({ required: ["gh"], missing: [] }, esc), /set-skbins--ok">gh found on this computer/);
  assert.equal(skillBinsRowHTML(undefined, esc), "");
  assert.equal(skillBinsDetailHTML(undefined, esc), "");
});
