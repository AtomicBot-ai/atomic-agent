import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DESKTOP_SHARED_WARNING,
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
    await uninstallCommand(["--yes"], deps);
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
    expect(legacyDesktopDirNotice("/x")).not.toContain("—");
  });
});
