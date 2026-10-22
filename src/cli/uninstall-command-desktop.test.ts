import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DESKTOP_DATA_QUESTION,
  DESKTOP_SHARED_WARNING,
  desktopDataKeptNotice,
  legacyDesktopDirNotice,
  noDesktopSharing,
  type DesktopSharing,
  type ResolvedUninstallPlan,
} from "../uninstall/index.js";
import {
  uninstallCommand,
  type UninstallCommandDeps,
} from "./uninstall-command.js";

const STATE_DIR = "/Users/op/.atomic-agent";
const BINARY = "/Users/op/.local/bin/atomic-agent";

const SHARED: DesktopSharing = {
  stateDir: STATE_DIR,
  signals: ["state-dirs-record", "app-installed"],
  sharesStateDir: true,
  legacyDir: null,
};

/** A plan over `paths`; leaving the state dir out is what --keep-data does. */
function makePlan(
  desktop: DesktopSharing,
  paths: readonly string[] = [STATE_DIR, BINARY],
): ResolvedUninstallPlan {
  const targets = paths.map((path) => ({
    path,
    label: path === STATE_DIR ? "config, memory, sessions" : "the binary",
    group: path === STATE_DIR ? ("data" as const) : ("program" as const),
  }));
  return {
    targets,
    measured: {
      targets: targets.map((t) => ({ ...t, exists: true, bytes: 1024 })),
      totalBytes: 1024 * targets.length,
    },
    devCheckout: false,
    installDir: "/Users/op/.local/bin",
    desktop,
  };
}

describe("atomic-agent uninstall: desktop app sharing the state folder", () => {
  let out: string[];
  let deps: UninstallCommandDeps;
  const resolvePlan = vi.fn();
  const run = vi.fn();

  beforeEach(() => {
    out = [];
    resolvePlan.mockReset();
    run.mockReset();
    run.mockResolvedValue({ removed: [], rcFilesEdited: [], complete: true });
    resolvePlan.mockResolvedValue(makePlan(noDesktopSharing(STATE_DIR)));
    deps = {
      resolvePlan:
        resolvePlan as unknown as UninstallCommandDeps["resolvePlan"],
      run: run as unknown as UninstallCommandDeps["run"],
      getStateDir: () => STATE_DIR,
      isTTY: () => true,
      ask: async () => "uninstall",
      write: (text) => void out.push(text),
      writeErr: () => undefined,
    };
  });

  const stdout = (): string => out.join("");

  it("warns right under the state folder line when the desktop shares it", async () => {
    resolvePlan.mockResolvedValue(makePlan(SHARED));
    await uninstallCommand(["--dry-run"], deps);
    const lines = stdout().split("\n");
    const stateRow = lines.findIndex((l) => l.includes(`${STATE_DIR}  (`));
    expect(stateRow).toBeGreaterThanOrEqual(0);
    expect(lines[stateRow + 1]).toContain("config, memory, sessions");
    expect(lines[stateRow + 2]).toContain(DESKTOP_SHARED_WARNING);
  });

  it("warns under --dry-run too", async () => {
    resolvePlan.mockResolvedValue(makePlan(SHARED));
    await uninstallCommand(["--dry-run"], deps);
    expect(stdout()).toContain(DESKTOP_SHARED_WARNING);
  });

  it("stays quiet when the desktop app is not found", async () => {
    await uninstallCommand(["--dry-run"], deps);
    expect(stdout()).not.toContain(DESKTOP_SHARED_WARNING);
    expect(stdout()).not.toContain("Left in place");
  });

  it("does not warn under --keep-data, where the folder stays", async () => {
    resolvePlan.mockResolvedValue(makePlan(SHARED, [BINARY]));
    await uninstallCommand(["--keep-data", "--dry-run"], deps);
    expect(stdout()).not.toContain(DESKTOP_SHARED_WARNING);
  });

  it("lists an old desktop folder as left in place, without the shared warning", async () => {
    resolvePlan.mockResolvedValue(
      makePlan({
        ...noDesktopSharing(STATE_DIR),
        signals: ["legacy-dir"],
        legacyDir: "/Users/op/.atomic-agent-desktop",
      }),
    );
    await uninstallCommand(["--dry-run"], deps);
    expect(stdout()).toContain(
      legacyDesktopDirNotice("/Users/op/.atomic-agent-desktop"),
    );
    expect(stdout()).not.toContain(DESKTOP_SHARED_WARNING);
  });

  it("never uses an em dash in the desktop wording", () => {
    expect(DESKTOP_SHARED_WARNING).not.toContain("—");
    expect(DESKTOP_DATA_QUESTION).not.toContain("—");
    expect(desktopDataKeptNotice("/x")).not.toContain("—");
    expect(legacyDesktopDirNotice("/x")).not.toContain("—");
  });

  const removedPaths = (): string[] =>
    (run.mock.calls[0]?.[0]?.targets ?? []).map(
      (target: { path: string }) => target.path,
    );

  describe("--yes (unattended)", () => {
    it("keeps the shared folder, removes only the program, and says why", async () => {
      resolvePlan.mockResolvedValue(makePlan(SHARED));
      const ask = vi.fn();
      const code = await uninstallCommand(["--yes"], { ...deps, ask });
      expect(code).toBe(0);
      expect(ask).not.toHaveBeenCalled();
      expect(removedPaths()).toEqual([BINARY]);
      expect(stdout()).toContain(desktopDataKeptNotice(STATE_DIR));
      expect(stdout()).toContain("--include-desktop-data");
      // The printed list is the removed list: no state-folder row.
      expect(stdout()).not.toContain(`${STATE_DIR}  (`);
      expect(stdout()).not.toContain("THIS CANNOT BE UNDONE");
    });

    it("shows the cut plan under --yes --dry-run too", async () => {
      resolvePlan.mockResolvedValue(makePlan(SHARED));
      await uninstallCommand(["--yes", "--dry-run"], deps);
      expect(run).not.toHaveBeenCalled();
      expect(stdout()).not.toContain(`${STATE_DIR}  (`);
      expect(stdout()).toContain(desktopDataKeptNotice(STATE_DIR));
    });

    it("removes nothing when the shared folder was the only target", async () => {
      resolvePlan.mockResolvedValue(makePlan(SHARED, [STATE_DIR]));
      const code = await uninstallCommand(["--yes", "--keep-binary"], deps);
      expect(code).toBe(0);
      expect(run).not.toHaveBeenCalled();
      expect(stdout()).toContain(desktopDataKeptNotice(STATE_DIR));
      expect(stdout()).toContain("nothing was removed");
    });

    it("deletes the folder when --include-desktop-data is passed", async () => {
      resolvePlan.mockResolvedValue(makePlan(SHARED));
      await uninstallCommand(["--yes", "--include-desktop-data"], deps);
      expect(removedPaths()).toEqual([STATE_DIR, BINARY]);
      expect(stdout()).toContain(DESKTOP_SHARED_WARNING);
      expect(stdout()).not.toContain(desktopDataKeptNotice(STATE_DIR));
    });

    it("deletes everything as before when the desktop app is not found", async () => {
      await uninstallCommand(["--yes"], deps);
      expect(removedPaths()).toEqual([STATE_DIR, BINARY]);
      expect(stdout()).not.toContain(desktopDataKeptNotice(STATE_DIR));
    });
  });

  describe("interactive run", () => {
    function answers(...replies: string[]) {
      const ask = vi.fn();
      for (const reply of replies) ask.mockResolvedValueOnce(reply);
      return ask;
    }

    it("asks a separate desktop question after the typed word, and yes deletes", async () => {
      resolvePlan.mockResolvedValue(makePlan(SHARED));
      const ask = answers("uninstall", "y");
      await uninstallCommand([], { ...deps, ask });
      expect(ask).toHaveBeenCalledTimes(2);
      expect(ask.mock.calls[1]?.[0]).toContain(DESKTOP_DATA_QUESTION);
      expect(removedPaths()).toEqual([STATE_DIR, BINARY]);
    });

    it("keeps the folder on anything but an explicit yes", async () => {
      for (const reply of ["", "n", "no", "uninstall"]) {
        out = [];
        run.mockClear();
        resolvePlan.mockResolvedValue(makePlan(SHARED));
        await uninstallCommand([], { ...deps, ask: answers("uninstall", reply) });
        expect(removedPaths()).toEqual([BINARY]);
        expect(stdout()).toContain(desktopDataKeptNotice(STATE_DIR));
      }
    });

    it("says in the plan that the desktop question is coming", async () => {
      resolvePlan.mockResolvedValue(makePlan(SHARED));
      await uninstallCommand(["--dry-run"], deps);
      expect(stdout()).toContain("asked separately");
    });

    it("never reaches the desktop question when the typed word is wrong", async () => {
      resolvePlan.mockResolvedValue(makePlan(SHARED));
      const ask = answers("nope");
      await uninstallCommand([], { ...deps, ask });
      expect(ask).toHaveBeenCalledTimes(1);
      expect(run).not.toHaveBeenCalled();
    });

    it("skips the desktop question under --include-desktop-data", async () => {
      resolvePlan.mockResolvedValue(makePlan(SHARED));
      const ask = answers("uninstall");
      await uninstallCommand(["--include-desktop-data"], { ...deps, ask });
      expect(ask).toHaveBeenCalledTimes(1);
      expect(removedPaths()).toEqual([STATE_DIR, BINARY]);
    });

    it("asks only the typed word when the desktop app is not found", async () => {
      const ask = answers("uninstall");
      await uninstallCommand([], { ...deps, ask });
      expect(ask).toHaveBeenCalledTimes(1);
      expect(removedPaths()).toEqual([STATE_DIR, BINARY]);
    });
  });

  it("rejects --include-desktop-data together with --keep-data", async () => {
    const errors: string[] = [];
    const code = await uninstallCommand(
      ["--keep-data", "--include-desktop-data"],
      { ...deps, writeErr: (text) => void errors.push(text) },
    );
    expect(code).toBe(2);
    expect(errors.join("")).toContain("--include-desktop-data");
    expect(resolvePlan).not.toHaveBeenCalled();
  });

  it("documents --include-desktop-data under --help", async () => {
    await uninstallCommand(["--help"], deps);
    expect(stdout()).toContain("--include-desktop-data");
  });
});
