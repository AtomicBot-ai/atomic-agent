import { describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import {
  formatRestoredWorkingDirNotice,
  resolveStartupWorkingDir,
  type StartupWorkingDirInput,
} from "./startup-working-dir.js";

const HOME = resolve("/home/op");
const STATE = join(HOME, ".atomic-agent");
const PROJECT = join(HOME, "code", "project");
const OTHER = join(HOME, "code", "other");

function input(
  overrides: Partial<StartupWorkingDirInput> = {},
): StartupWorkingDirInput {
  return {
    args: [],
    cwd: HOME,
    homeDir: HOME,
    stateDir: STATE,
    recentDirs: () => [PROJECT],
    isDirectory: () => true,
    ...overrides,
  };
}

describe("resolveStartupWorkingDir", () => {
  it("reopens the last session's folder on a bare launch from home", () => {
    expect(resolveStartupWorkingDir(input())).toEqual({
      workingDir: PROJECT,
      restored: true,
    });
  });

  it("keeps the shell's folder when it is not home, without reading history", () => {
    const recentDirs = vi.fn(() => [OTHER]);
    expect(
      resolveStartupWorkingDir(input({ cwd: PROJECT, recentDirs })),
    ).toEqual({ workingDir: PROJECT, restored: false });
    expect(recentDirs).not.toHaveBeenCalled();
  });

  it.each([["--cwd"], ["--working-dir"], ["--session"]])(
    "never overrides an explicit %s",
    (flag) => {
      const recentDirs = vi.fn(() => [PROJECT]);
      expect(
        resolveStartupWorkingDir(
          input({ args: [flag, "value"], recentDirs }),
        ),
      ).toEqual({ workingDir: HOME, restored: false });
      expect(recentDirs).not.toHaveBeenCalled();
    },
  );

  it("stays in home when there is no history", () => {
    expect(resolveStartupWorkingDir(input({ recentDirs: () => [] }))).toEqual({
      workingDir: HOME,
      restored: false,
    });
  });

  it("stays in home when the last session was in home too", () => {
    expect(
      resolveStartupWorkingDir(input({ recentDirs: () => [HOME, PROJECT] })),
    ).toEqual({ workingDir: HOME, restored: false });
  });

  it("skips a folder that no longer exists and takes the next one", () => {
    expect(
      resolveStartupWorkingDir(
        input({
          recentDirs: () => [PROJECT, OTHER],
          isDirectory: (dir) => dir === OTHER,
        }),
      ),
    ).toEqual({ workingDir: OTHER, restored: true });
  });

  it("skips sessions that ran inside the state dir", () => {
    expect(
      resolveStartupWorkingDir(
        input({ recentDirs: () => [join(STATE, "workspace"), PROJECT] }),
      ),
    ).toEqual({ workingDir: PROJECT, restored: true });
  });

  it("stays in home when reading history throws", () => {
    expect(
      resolveStartupWorkingDir(
        input({
          recentDirs: () => {
            throw new Error("locked");
          },
        }),
      ),
    ).toEqual({ workingDir: HOME, restored: false });
  });
});

describe("formatRestoredWorkingDirNotice", () => {
  it("shortens a folder under home and says how to stay put", () => {
    const text = formatRestoredWorkingDirNotice(PROJECT, HOME);
    expect(text).toContain(`~/${join("code", "project")}`);
    expect(text).toContain("--cwd .");
  });

  it("prints a folder outside home as is", () => {
    const outside = resolve("/srv/repo");
    expect(formatRestoredWorkingDirNotice(outside, HOME)).toContain(outside);
  });
});
