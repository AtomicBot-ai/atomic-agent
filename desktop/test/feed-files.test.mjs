// ATO-1230: the desktop-latest feed went up without stable-linux.yml /
// stable-linux-arm64.yml, so no AppImage could update. scripts/feed-files.mjs
// refuses a feed folder that misses a platform's update file or a file it names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SUMS, checkFeed, checkSums, feedYmlNames, namedFiles, parseSums } from "../scripts/feed-files.mjs";

const V = "0.0.8";
const YML = {
  "stable-mac.yml": `version: ${V}
files:
  - url: Atomic-Agent-${V}-arm64-mac.zip
    sha512: m
    size: 1
path: Atomic-Agent-${V}-arm64-mac.zip
sha512: m
`,
  "stable.yml": `version: ${V}
files:
  - url: Atomic-Agent-Setup-${V}-x64.exe
    sha512: a
  - url: Atomic-Agent-Setup-${V}-arm64.exe
    sha512: b
path: Atomic-Agent-Setup-${V}-x64.exe
sha512: a
`,
  "stable-linux.yml": `version: ${V}
files:
  - url: Atomic-Agent-${V}-x86_64.AppImage
    sha512: l
    blockMapSize: 10
path: Atomic-Agent-${V}-x86_64.AppImage
sha512: l
releaseDate: '2026-11-06T10:00:00.000Z'
`,
  "stable-linux-arm64.yml": `version: ${V}
files:
  - url: Atomic-Agent-${V}-arm64.AppImage
    sha512: r
path: Atomic-Agent-${V}-arm64.AppImage
sha512: r
`,
};

const INSTALLERS = [
  `Atomic-Agent-${V}-arm64-mac.zip`,
  `Atomic-Agent-${V}-arm64-mac.zip.blockmap`,
  `Atomic-Agent-Setup-${V}-x64.exe`,
  `Atomic-Agent-Setup-${V}-arm64.exe`,
  `Atomic-Agent-${V}-x86_64.AppImage`,
  `Atomic-Agent-${V}-arm64.AppImage`,
  `Atomic-Agent-${V}-amd64.deb`,
];

function folder(overrides = {}, drop = []) {
  const texts = { ...YML, ...overrides };
  const files = [...INSTALLERS, ...Object.keys(texts)].filter((f) => !drop.includes(f));
  return [files, (name) => texts[name]];
}

test("electron-updater's names: <channel>-linux.yml on x64, -linux-arm64 on arm64", () => {
  assert.deepEqual(feedYmlNames("stable"), {
    mac: "stable-mac.yml",
    windows: "stable.yml",
    "linux-x64": "stable-linux.yml",
    "linux-arm64": "stable-linux-arm64.yml",
  });
  assert.equal(feedYmlNames("beta")["linux-x64"], "beta-linux.yml");
  assert.throws(() => feedYmlNames("../x"));
});

test("a complete feed passes; installers go first, the yml files last", () => {
  const { problems, uploadFirst, uploadLast } = checkFeed(...folder());
  assert.deepEqual(problems, []);
  assert.deepEqual(uploadLast, ["stable-mac.yml", "stable.yml", "stable-linux.yml", "stable-linux-arm64.yml"]);
  assert.ok(uploadFirst.includes(`Atomic-Agent-${V}-x86_64.AppImage`));
  assert.ok(uploadFirst.includes(`Atomic-Agent-${V}-arm64.AppImage`));
  assert.ok(uploadFirst.includes(`Atomic-Agent-${V}-arm64-mac.zip.blockmap`));
  // The .deb is not part of the feed (a .deb never updates itself).
  assert.ok(!uploadFirst.some((f) => f.endsWith(".deb")));
});

test("the 0.0.7 feed (mac + Windows only) is refused, naming both Linux files", () => {
  const { problems } = checkFeed(...folder({}, ["stable-linux.yml", "stable-linux-arm64.yml"]));
  assert.equal(problems.length, 2);
  assert.match(problems[0], /stable-linux\.yml is missing/);
  assert.match(problems[1], /stable-linux-arm64\.yml is missing/);
});

test("a yml whose AppImage is not in the folder is refused", () => {
  const { problems } = checkFeed(...folder({}, [`Atomic-Agent-${V}-arm64.AppImage`]));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /stable-linux-arm64\.yml: names Atomic-Agent-0\.0\.8-arm64\.AppImage, which is not in the folder/);
});

test("a single Windows job's stable.yml (not merged) is refused", () => {
  const single = YML["stable.yml"].replace(/  - url: Atomic-Agent-Setup-0\.0\.8-arm64\.exe\n    sha512: b\n/, "");
  const { problems } = checkFeed(...folder({ "stable.yml": single }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /both the x64 and the arm64 installer/);
});

test("update files of different versions are refused", () => {
  const old = YML["stable-linux.yml"].replace(/^version: .*$/m, "version: 0.0.7");
  const { problems } = checkFeed(...folder({ "stable-linux.yml": old }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /different versions/);
});

test("namedFiles reads files[].url and the legacy path, quoted or not", () => {
  assert.deepEqual(namedFiles("files:\n  - url: 'a.AppImage'\n    sha512: x\npath: a.AppImage\n"), ["a.AppImage"]);
  assert.deepEqual(namedFiles('files:\n  - url: "b.exe"\n'), ["b.exe"]);
});

// ATO-685: the desktop-feed workflow checks SHA256SUMS.txt and the blockmaps too.
const H = (name) => name.length.toString(16).padStart(64, "0");

test("a .zip or .exe without its .blockmap is a warning, not a problem", () => {
  const { problems, warnings } = checkFeed(...folder());
  assert.deepEqual(problems, []);
  assert.ok(warnings.some((w) => w.includes(`Atomic-Agent-Setup-${V}-x64.exe has no .blockmap`)));
  assert.ok(!warnings.some((w) => w.includes("mac.zip has no")));
  assert.ok(!warnings.some((w) => w.includes(".AppImage")));
});

test("SHA256SUMS.txt in the folder is uploaded with the installers", () => {
  const [files, read] = folder();
  const { uploadFirst, uploadLast } = checkFeed([...files, SUMS], read);
  assert.ok(uploadFirst.includes(SUMS));
  assert.ok(!uploadLast.includes(SUMS));
});

test("SHA256SUMS.txt must list every feed file with the right hash", () => {
  const [files] = folder();
  const { uploadFirst, uploadLast } = checkFeed(...folder());
  const feed = [...uploadFirst, ...uploadLast];
  const listed = feed.filter((n) => !n.endsWith(".yml") && !n.endsWith(".blockmap"));
  const good = listed.map((n) => `${H(n)}  ${n}`).join("\n") + "\n";
  assert.deepEqual(checkSums([...files, SUMS], good, feed, H), []);

  // A file left out of the sums.
  const missing = listed.slice(1).map((n) => `${H(n)}  ${n}`).join("\n");
  assert.deepEqual(checkSums(files, missing, feed, H), [`${SUMS}: does not list ${listed[0]}`]);

  // A hash that does not match, and a listed file that is not in the folder.
  const wrong = good.replace(H(listed[0]), "f".repeat(64)) + `${"a".repeat(64)}  gone.dmg\n`;
  const problems = checkSums(files, wrong, feed, H);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /does not match its sha256/);
  assert.match(problems[1], /lists gone\.dmg, which is not in the folder/);
});

test("parseSums reads sha256sum output, binary-mode star included, and flags junk", () => {
  const { sums, bad } = parseSums(`${"A".repeat(64)}  a.dmg\n${"b".repeat(64)} *b.exe\nnot a line\n`);
  assert.equal(sums.get("a.dmg"), "a".repeat(64));
  assert.equal(sums.get("b.exe"), "b".repeat(64));
  assert.deepEqual(bad, ["not a line"]);
});
