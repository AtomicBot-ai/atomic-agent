import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  copyNodePtyRuntime,
  nodePtyPrebuildName,
  pickNodePtyPrebuilds,
} from "./copy-node-pty-runtime.js";

/** ATO-2484: the pty binding ships next to the SEA binary like the keyring. */
describe("copyNodePtyRuntime", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("names and picks only the target's prebuild", () => {
    expect(nodePtyPrebuildName("win32", "x64")).toBe("node-pty-win32-x64");
    expect(
      pickNodePtyPrebuilds(["node-pty", "node-pty-darwin-arm64", "node-pty-darwin-x64"], "darwin", "arm64"),
    ).toEqual(["node-pty-darwin-arm64"]);
  });

  it("copies the main package and the target prebuild, keeping spawn-helper executable", async () => {
    dir = await mkdtemp(join(tmpdir(), "node-pty-copy-"));
    const scope = join(dir, "root", "node_modules", "@lydell");
    await mkdir(join(scope, "node-pty", "lib"), { recursive: true });
    await writeFile(join(scope, "node-pty", "package.json"), "{}");
    await writeFile(join(scope, "node-pty", "lib", "index.js"), "");
    await mkdir(join(scope, "node-pty-darwin-arm64", "prebuilds"), { recursive: true });
    await writeFile(join(scope, "node-pty-darwin-arm64", "prebuilds", "pty.node"), "");
    await writeFile(join(scope, "node-pty-darwin-arm64", "prebuilds", "spawn-helper"), "", { mode: 0o755 });
    await mkdir(join(scope, "node-pty-linux-x64"), { recursive: true });
    const stage = join(dir, "stage");
    const result = await copyNodePtyRuntime(join(dir, "root"), stage, { platform: "darwin", arch: "arm64" });
    expect(result).toEqual({ copiedMain: true, prebuilds: ["node-pty-darwin-arm64"], warnings: [] });
    const out = join(stage, "node_modules", "@lydell");
    expect((await readdir(out)).sort()).toEqual(["node-pty", "node-pty-darwin-arm64"]);
    expect(await readdir(join(out, "node-pty", "lib"))).toEqual(["index.js"]);
    if (process.platform !== "win32") {
      const mode = (await stat(join(out, "node-pty-darwin-arm64", "prebuilds", "spawn-helper"))).mode;
      expect(mode & 0o111).not.toBe(0);
    }
  });

  it("warns instead of failing when the package or the prebuild is missing", async () => {
    dir = await mkdtemp(join(tmpdir(), "node-pty-copy-"));
    const none = await copyNodePtyRuntime(join(dir, "empty"), join(dir, "stage"), { platform: "linux", arch: "x64" });
    expect(none.copiedMain).toBe(false);
    expect(none.warnings[0]).toContain("not found");
    await mkdir(join(dir, "root", "node_modules", "@lydell", "node-pty"), { recursive: true });
    const noPrebuild = await copyNodePtyRuntime(join(dir, "root"), join(dir, "stage2"), { platform: "linux", arch: "x64" });
    expect(noPrebuild.copiedMain).toBe(true);
    expect(noPrebuild.warnings[0]).toContain("node-pty-linux-x64");
  });
});
