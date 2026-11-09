// ATO-1230: the desktop-latest feed went up without stable-linux.yml /
// stable-linux-arm64.yml, so no AppImage could update. scripts/feed-files.mjs
// refuses a feed folder that misses a platform's update file or a file it names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFeed, feedYmlNames, namedFiles } from "../scripts/feed-files.mjs";

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
