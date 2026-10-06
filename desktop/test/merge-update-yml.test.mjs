// ATO-252: one stable.yml for both Windows arches (scripts/merge-update-yml.mjs).
// electron-updater picks the installer whose name contains process.arch, so the
// merged file must list both and keep the legacy path on x64.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeUpdateInfo, mergeUpdateYml } from "../scripts/merge-update-yml.mjs";

const X64 = `version: 0.6.10
files:
  - url: Atomic-Agent-Setup-0.6.10-x64.exe
    sha512: AAAx64
    size: 100
path: Atomic-Agent-Setup-0.6.10-x64.exe
sha512: AAAx64
releaseDate: '2026-10-06T10:00:00.000Z'
releaseNotes: First line of the notes.
`;

const ARM64 = `version: 0.6.10
files:
  - url: Atomic-Agent-Setup-0.6.10-arm64.exe
    sha512: BBBarm64
    size: 90
path: Atomic-Agent-Setup-0.6.10-arm64.exe
sha512: BBBarm64
releaseDate: '2026-10-06T10:05:00.000Z'
`;

test("both installers are listed, legacy path stays x64, the later date wins", () => {
  const out = mergeUpdateYml(X64, ARM64);
  assert.match(out, /url: Atomic-Agent-Setup-0\.6\.10-x64\.exe/);
  assert.match(out, /url: Atomic-Agent-Setup-0\.6\.10-arm64\.exe/);
  assert.match(out, /^path: Atomic-Agent-Setup-0\.6\.10-x64\.exe$/m);
  assert.match(out, /^sha512: AAAx64$/m);
  assert.match(out, /releaseDate: '2026-10-06T10:05:00\.000Z'/);
  assert.match(out, /releaseNotes: First line of the notes\./);
});

test("what electron-updater picks: the file whose name contains process.arch", () => {
  const merged = mergeUpdateInfo(
    { version: "1.0.0", files: [{ url: "S-1.0.0-x64.exe", sha512: "a" }], path: "S-1.0.0-x64.exe", sha512: "a" },
    { version: "1.0.0", files: [{ url: "S-1.0.0-arm64.exe", sha512: "b" }], path: "S-1.0.0-arm64.exe", sha512: "b" },
  );
  const pick = (arch) => merged.files.find((f) => f.url.includes(arch))?.url;
  assert.equal(pick("x64"), "S-1.0.0-x64.exe");
  assert.equal(pick("arm64"), "S-1.0.0-arm64.exe");
});

test("an unquoted timestamp (parsed as a Date) comes out as an ISO string", () => {
  const merged = mergeUpdateInfo(
    { version: "1.0.0", files: [{ url: "x64.exe", sha512: "a" }], releaseDate: new Date("2026-01-01T00:00:00Z") },
    { version: "1.0.0", files: [{ url: "arm64.exe", sha512: "b" }], releaseDate: "2025-12-31T00:00:00.000Z" },
  );
  assert.equal(merged.releaseDate, "2026-01-01T00:00:00.000Z");
});

test("refuses two different versions, swapped arguments and a clashing hash", () => {
  assert.throws(() => mergeUpdateYml(X64, ARM64.replaceAll("0.6.10", "0.6.11")), /versions differ/);
  assert.throws(() => mergeUpdateYml(ARM64, X64), /no x64 installer/);
  const clash = ARM64.replace("files:\n", "files:\n  - url: Atomic-Agent-Setup-0.6.10-x64.exe\n    sha512: ZZZ\n");
  assert.throws(() => mergeUpdateYml(X64, clash), /different sha512/);
  assert.throws(() => mergeUpdateInfo({ version: "1" }, { version: "1" }), /no files/);
});
