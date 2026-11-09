// ATO-1203: a Dock-opened app has launchd's short PATH, so `atag` could not
// find a claude/codex CLI in ~/.local/bin or /opt/homebrew/bin. agentEnv
// appends the installer folders the PATH does not hold yet.
// Against the built output (npm run build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { withInstallerBinDirs, installerBinDirs } = require("../out/main/installer-path.js");

const HOME = "/Users/someone";

test("launchd's short PATH gets the installer folders appended, in order", () => {
  const out = withInstallerBinDirs("/usr/bin:/bin:/usr/sbin:/sbin", "darwin", HOME);
  assert.equal(out, [
    "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    `${HOME}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin",
    `${HOME}/.npm-global/bin`, `${HOME}/.bun/bin`, `${HOME}/.volta/bin`,
  ].join(":"));
});

test("folders already on PATH stay where they are and are not added twice", () => {
  const terminal = `/opt/homebrew/bin:${HOME}/.local/bin/:/usr/bin:/bin`;
  const out = withInstallerBinDirs(terminal, "darwin", HOME);
  assert.ok(out.startsWith(terminal + ":"), "the person's own order comes first, untouched");
  const parts = out.split(":");
  assert.equal(parts.filter((d) => d === "/opt/homebrew/bin").length, 1);
  assert.equal(parts.filter((d) => d.replace(/\/+$/, "") === `${HOME}/.local/bin`).length, 1);
});

test("a PATH that already holds every folder comes back as it was", () => {
  const full = ["/usr/bin", ...installerBinDirs(HOME)].join(":");
  assert.equal(withInstallerBinDirs(full, "linux", HOME), full);
});

test("Linux gets the same folders; Windows is left alone", () => {
  assert.match(withInstallerBinDirs("/usr/bin", "linux", "/home/someone"), /:\/home\/someone\/\.local\/bin:/);
  assert.equal(withInstallerBinDirs("C:\\Windows\\system32", "win32", "C:\\Users\\someone"), "C:\\Windows\\system32");
});

test("no PATH at all, or no usable home", () => {
  assert.equal(withInstallerBinDirs(undefined, "darwin", HOME), installerBinDirs(HOME).join(":"));
  assert.equal(withInstallerBinDirs("/usr/bin", "darwin", ""), "/usr/bin");
  assert.equal(withInstallerBinDirs("/usr/bin", "darwin", "relative/home"), "/usr/bin");
});
