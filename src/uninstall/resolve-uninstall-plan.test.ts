import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveUninstallPlan } from "./resolve-uninstall-plan.js";

// Real temp dirs read as macOS paths; a Windows temp path is not one.
describe.skipIf(process.platform === "win32")("resolveUninstallPlan: desktop app", () => {
  let home: string;
  let stateDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "uninstall-desktop-"));
    stateDir = join(home, ".atomic-agent");
    mkdirSync(stateDir);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const resolveIn = () =>
    resolveUninstallPlan({
      stateDir,
      homeDir: home,
      platform: "darwin",
      execPath: "/usr/local/bin/node",
      env: {},
      // Only the fake home counts: the real /Applications is not ours to read.
      desktopProbe: { exists: (path) => path.startsWith(home) && existsSync(path) },
    });

  it("reports the desktop's record of this folder on the plan", async () => {
    const userData = join(home, "Library", "Application Support", "Atomic Agent");
    mkdirSync(userData, { recursive: true });
    writeFileSync(join(userData, "state-dirs.json"), JSON.stringify({ dirs: [stateDir] }));
    mkdirSync(join(home, ".atomic-agent-desktop"));

    const plan = await resolveIn();
    expect(plan.desktop.sharesStateDir).toBe(true);
    expect(plan.desktop.signals).toEqual(["state-dirs-record", "legacy-dir"]);
    expect(plan.desktop.legacyDir).toBe(join(home, ".atomic-agent-desktop"));
  });

  it("removes exactly the same targets whether or not the desktop is there", async () => {
    const without = await resolveIn();
    expect(without.desktop.signals).toEqual([]);

    const userData = join(home, "Library", "Application Support", "Atomic Agent");
    mkdirSync(userData, { recursive: true });
    writeFileSync(join(userData, "state-dirs.json"), JSON.stringify({ dirs: [stateDir] }));
    mkdirSync(join(home, ".atomic-agent-desktop"));
    const withDesktop = await resolveIn();

    expect(withDesktop.targets).toEqual(without.targets);
    expect(withDesktop.targets.map((t) => t.path)).not.toContain(
      join(home, ".atomic-agent-desktop"),
    );
  });
});
