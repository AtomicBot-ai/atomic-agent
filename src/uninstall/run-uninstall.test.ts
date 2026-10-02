import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INSTALLER_PATH_MARKER } from "./strip-installer-path-line.js";
import { runUninstall } from "./run-uninstall.js";
import type { UserPathStore } from "./windows-user-path.js";
import { measureUninstallPlan, formatBytes } from "./measure-uninstall-plan.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "aa-uninstall-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("runUninstall", () => {
  it("removes files and directories and reports each one", async () => {
    const stateDir = join(home, ".atomic-agent");
    await mkdir(join(stateDir, "models"), { recursive: true });
    await writeFile(join(stateDir, "config.json"), "{}");
    const binary = join(home, "bin", "atomic-agent");
    await mkdir(join(home, "bin"), { recursive: true });
    await writeFile(binary, "#!/bin/sh\n");

    const result = await runUninstall({
      targets: [
        { path: stateDir, label: "state", group: "data" },
        { path: binary, label: "binary", group: "program" },
      ],
      homeDir: home,
    });

    expect(result.complete).toBe(true);
    expect(await exists(stateDir)).toBe(false);
    expect(await exists(binary)).toBe(false);
  });

  it("treats a missing target as removed rather than a failure", async () => {
    const result = await runUninstall({
      targets: [{ path: join(home, "gone"), label: "x", group: "data" }],
      homeDir: home,
    });
    expect(result.complete).toBe(true);
  });

  it("refuses a target outside anything we install", async () => {
    const result = await runUninstall({
      targets: [{ path: home, label: "home!", group: "data" }],
      homeDir: home,
    });
    expect(result.complete).toBe(false);
    expect(result.removed[0]?.error).toMatch(/refused/);
    expect(await exists(home)).toBe(true);
  });

  it("keeps going after a refusal so one bad target cannot strand the rest", async () => {
    const stateDir = join(home, ".atomic-agent");
    await mkdir(stateDir, { recursive: true });
    const result = await runUninstall({
      targets: [
        { path: "/", label: "root", group: "program" },
        { path: stateDir, label: "state", group: "data" },
      ],
      homeDir: home,
    });
    expect(result.complete).toBe(false);
    expect(await exists(stateDir)).toBe(false);
  });

  it("takes the installer's PATH stanza back out of the rc file", async () => {
    const rc = join(home, ".zshrc");
    await writeFile(
      rc,
      `export EDITOR=vim\n\n${INSTALLER_PATH_MARKER}\nexport PATH="$HOME/.local/bin:$PATH"\n`,
    );
    const result = await runUninstall({ targets: [], homeDir: home });
    expect(result.rcFilesEdited).toEqual([rc]);
    expect(await readFile(rc, "utf8")).toBe("export EDITOR=vim\n");
  });

  it("leaves the rc file alone under --keep-path", async () => {
    const rc = join(home, ".zshrc");
    const original = `${INSTALLER_PATH_MARKER}\nexport PATH=x\n`;
    await writeFile(rc, original);
    const result = await runUninstall({
      targets: [],
      homeDir: home,
      keepPathEntry: true,
    });
    expect(result.rcFilesEdited).toEqual([]);
    expect(await readFile(rc, "utf8")).toBe(original);
  });

  function fakeUserPath(initial: string | null): UserPathStore & {
    writes: string[];
  } {
    const writes: string[] = [];
    return {
      writes,
      read: async () => initial,
      write: async (value) => {
        writes.push(value);
      },
    };
  }

  it("takes the install dir back off the windows user PATH", async () => {
    const store = fakeUserPath(
      "C:\\Tools;C:\\Users\\op\\AppData\\Local\\atomic-agent",
    );
    const result = await runUninstall({
      targets: [],
      homeDir: home,
      platform: "win32",
      installDir: "C:\\Users\\op\\AppData\\Local\\atomic-agent",
      userPathStore: store,
    });
    expect(store.writes).toEqual(["C:\\Tools"]);
    expect(result.userPathEntryRemoved).toBe(
      "C:\\Users\\op\\AppData\\Local\\atomic-agent",
    );
    expect(result.complete).toBe(true);
  });

  it("leaves the windows user PATH alone under --keep-path", async () => {
    const store = fakeUserPath("C:\\Tools;C:\\aa");
    const result = await runUninstall({
      targets: [],
      homeDir: home,
      platform: "win32",
      installDir: "C:\\aa",
      keepPathEntry: true,
      userPathStore: store,
    });
    expect(store.writes).toEqual([]);
    expect(result.userPathEntryRemoved).toBeUndefined();
  });

  it("does not write the user PATH when the install dir is not on it", async () => {
    const store = fakeUserPath("C:\\Tools");
    await runUninstall({
      targets: [],
      homeDir: home,
      platform: "win32",
      installDir: "C:\\aa",
      userPathStore: store,
    });
    expect(store.writes).toEqual([]);
  });

  it("never touches the user PATH without an install dir or off windows", async () => {
    const store = fakeUserPath("C:\\aa");
    await runUninstall({
      targets: [],
      homeDir: home,
      platform: "win32",
      userPathStore: store,
    });
    await runUninstall({
      targets: [],
      homeDir: home,
      platform: "darwin",
      installDir: "C:\\aa",
      userPathStore: store,
    });
    expect(store.writes).toEqual([]);
  });

  it("reports a user PATH it could not edit instead of claiming success", async () => {
    const result = await runUninstall({
      targets: [],
      homeDir: home,
      platform: "win32",
      installDir: "C:\\aa",
      userPathStore: {
        read: async () => "C:\\aa",
        write: async () => {
          throw new Error("access denied");
        },
      },
    });
    expect(result.complete).toBe(false);
    expect(result.removed[0]?.error).toBe("access denied");
  });

  it("narrates every removal through onProgress", async () => {
    const doomed = join(home, ".atomic-agent");
    await mkdir(doomed, { recursive: true });
    const lines: string[] = [];
    await runUninstall({
      targets: [{ path: doomed, label: "state", group: "data" }],
      homeDir: home,
      onProgress: (line) => lines.push(line),
    });
    expect(lines).toEqual([`removing ${doomed}`]);
  });
});

describe("measureUninstallPlan", () => {
  it("sums a directory recursively and drops what is not there", async () => {
    const stateDir = join(home, ".atomic-agent");
    await mkdir(join(stateDir, "models"), { recursive: true });
    await writeFile(join(stateDir, "config.json"), "x".repeat(100));
    await writeFile(join(stateDir, "models", "a.gguf"), "y".repeat(400));

    const plan = await measureUninstallPlan([
      { path: stateDir, label: "state", group: "data" },
      { path: join(home, "nope"), label: "missing", group: "data" },
    ]);

    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]?.bytes).toBeGreaterThanOrEqual(500);
    expect(plan.totalBytes).toBe(plan.targets[0]?.bytes);
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [999, "999 B"],
    [1024, "1 KB"],
    [1536, "1.5 KB"],
    [1024 * 1024 * 1024 * 1.7, "1.7 GB"],
  ])("%i -> %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
