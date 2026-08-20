import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  buildUninstallPlan,
  formatUninstallPlan,
  isEmptyPlan,
  isSharedInstallDir,
  PATH_MARKER,
  stripPathBlock,
  type BuildUninstallPlanParams,
} from "./uninstall-plan.js";
import { runUninstall, type RunUninstallDeps } from "./run-uninstall.js";

const HOME = "/home/op";
const SHARED_DIR = join(HOME, ".local", "bin");
const OWN_DIR = join(HOME, "AppData", "Local", "atomic-agent");
const STATE_DIR = join(HOME, ".atomic-agent");

/** Every path the installer could have written, plus a foreign binary. */
const FULL_DISK = new Set<string>([
  join(SHARED_DIR, "atomic-agent"),
  join(SHARED_DIR, "atag"),
  join(SHARED_DIR, "grammars"),
  join(SHARED_DIR, "starter-skills"),
  join(SHARED_DIR, "assets"),
  join(SHARED_DIR, "vendor"),
  join(SHARED_DIR, "prebuilds"),
  join(SHARED_DIR, "node_modules"),
  // Not ours. Must survive every plan below.
  join(SHARED_DIR, "ripgrep"),
  join(SHARED_DIR, "some-other-tool"),
  STATE_DIR,
]);

function makeParams(
  overrides: Partial<BuildUninstallPlanParams> = {},
): BuildUninstallPlanParams {
  return {
    scopes: ["app", "path"],
    installDir: SHARED_DIR,
    stateDir: STATE_DIR,
    home: HOME,
    platform: "linux",
    exists: (path) => FULL_DISK.has(path),
    readFile: () => null,
    ...overrides,
  };
}

describe("isSharedInstallDir", () => {
  it("treats ~/.local/bin as shared — other programs live there", () => {
    expect(isSharedInstallDir(SHARED_DIR, HOME)).toBe(true);
  });

  it("treats /usr/local/bin and ~/bin as shared", () => {
    expect(isSharedInstallDir("/usr/local/bin", HOME)).toBe(true);
    expect(isSharedInstallDir(join(HOME, "bin"), HOME)).toBe(true);
  });

  it("treats a directory named after the product as ours", () => {
    expect(isSharedInstallDir(OWN_DIR, HOME)).toBe(false);
  });

  it("ignores a trailing separator", () => {
    expect(isSharedInstallDir(`${OWN_DIR}/`, HOME)).toBe(false);
  });
});

describe("buildUninstallPlan", () => {
  it("never removes the shared install directory itself", () => {
    const plan = buildUninstallPlan(makeParams());
    const paths = plan.targets.map((t) => t.path);
    expect(paths).not.toContain(SHARED_DIR);
    expect(plan.preservedInstallDir).toBe(SHARED_DIR);
  });

  it("leaves foreign binaries in a shared directory untouched", () => {
    const plan = buildUninstallPlan(makeParams());
    const paths = plan.targets.map((t) => t.path);
    expect(paths).not.toContain(join(SHARED_DIR, "ripgrep"));
    expect(paths).not.toContain(join(SHARED_DIR, "some-other-tool"));
  });

  it("removes the binary, the alias, and every installed asset tree", () => {
    const plan = buildUninstallPlan(makeParams());
    const paths = plan.targets.map((t) => t.path);
    for (const name of [
      "atomic-agent",
      "atag",
      "grammars",
      "starter-skills",
      "assets",
      "vendor",
      "prebuilds",
      "node_modules",
    ]) {
      expect(paths).toContain(join(SHARED_DIR, name));
    }
  });

  it("keeps the state directory out of the default plan", () => {
    const plan = buildUninstallPlan(makeParams());
    expect(plan.targets.map((t) => t.path)).not.toContain(STATE_DIR);
    expect(plan.notes.join(" ")).toContain("State kept at");
  });

  it("includes the state directory only when that scope is asked for", () => {
    const plan = buildUninstallPlan(
      makeParams({ scopes: ["app", "path", "state"] }),
    );
    expect(plan.targets.map((t) => t.path)).toContain(STATE_DIR);
    expect(plan.notes.join(" ")).toContain("not reversible");
  });

  it("skips paths that are not on disk", () => {
    const plan = buildUninstallPlan(
      makeParams({ exists: (p) => p === join(SHARED_DIR, "atomic-agent") }),
    );
    expect(plan.targets).toHaveLength(1);
  });

  it("finds the installer's PATH block in a shell rc file", () => {
    const rc = join(HOME, ".zshrc");
    const plan = buildUninstallPlan(
      makeParams({
        scopes: ["path"],
        readFile: (p) =>
          p === rc ? `export A=1\n\n${PATH_MARKER}\nexport PATH="x:$PATH"\n` : null,
      }),
    );
    expect(plan.pathEdits.map((e) => e.file)).toEqual([rc]);
  });

  it("ignores rc files that the installer never touched", () => {
    const plan = buildUninstallPlan(
      makeParams({ scopes: ["path"], readFile: () => "export PATH=/x:$PATH\n" }),
    );
    expect(plan.pathEdits).toHaveLength(0);
  });

  it("explains the registry PATH edit on Windows", () => {
    const plan = buildUninstallPlan(
      makeParams({ scopes: ["path"], platform: "win32" }),
    );
    expect(plan.notes.join(" ")).toContain("registry");
  });

  it("reports an empty plan when nothing is installed", () => {
    const plan = buildUninstallPlan(makeParams({ exists: () => false }));
    expect(isEmptyPlan(plan)).toBe(true);
    expect(formatUninstallPlan(plan)).toContain("Nothing to remove");
  });
});

describe("stripPathBlock", () => {
  it("removes the marker and the export line under it", () => {
    const before = `export EDITOR=vim\n\n${PATH_MARKER}\nexport PATH="$HOME/.local/bin:$PATH"\n`;
    expect(stripPathBlock(before, PATH_MARKER)).toBe("export EDITOR=vim\n");
  });

  it("leaves an untouched file exactly as it was", () => {
    const before = 'export PATH="/opt/bin:$PATH"\n';
    expect(stripPathBlock(before, PATH_MARKER)).toBe(before);
  });

  it("is idempotent — running it twice changes nothing further", () => {
    const before = `a=1\n\n${PATH_MARKER}\nexport PATH="x:$PATH"\n`;
    const once = stripPathBlock(before, PATH_MARKER);
    expect(stripPathBlock(once, PATH_MARKER)).toBe(once);
  });

  it("preserves lines that follow the block", () => {
    const before = `a=1\n\n${PATH_MARKER}\nexport PATH="x:$PATH"\nb=2\n`;
    expect(stripPathBlock(before, PATH_MARKER)).toBe("a=1\nb=2\n");
  });
});

describe("runUninstall", () => {
  function makeDeps(
    failOn: readonly string[] = [],
  ): { deps: RunUninstallDeps; removed: string[]; written: [string, string][] } {
    const removed: string[] = [];
    const written: [string, string][] = [];
    return {
      removed,
      written,
      deps: {
        rm: (path) => {
          if (failOn.includes(path)) throw new Error("EACCES");
          removed.push(path);
        },
        readFile: () => `\n${PATH_MARKER}\nexport PATH="x:$PATH"\n`,
        writeFile: (path, contents) => written.push([path, contents]),
      },
    };
  }

  it("removes every planned target and reports them", () => {
    const plan = buildUninstallPlan(makeParams());
    const { deps, removed } = makeDeps();
    const outcome = runUninstall(plan, deps);
    expect(outcome.failures).toHaveLength(0);
    expect(removed).toHaveLength(plan.targets.length);
  });

  it("removes the binary last so a partial failure leaves a way to retry", () => {
    const plan = buildUninstallPlan(makeParams());
    const { deps, removed } = makeDeps();
    runUninstall(plan, deps);
    expect(removed[removed.length - 1]).toContain("at");
    const binaryIndex = removed.indexOf(join(SHARED_DIR, "atomic-agent"));
    const assetIndex = removed.indexOf(join(SHARED_DIR, "grammars"));
    expect(binaryIndex).toBeGreaterThan(assetIndex);
  });

  it("keeps going after a failure and reports what could not be removed", () => {
    const plan = buildUninstallPlan(makeParams());
    const blocked = join(SHARED_DIR, "vendor");
    const { deps, removed } = makeDeps([blocked]);
    const outcome = runUninstall(plan, deps);
    expect(outcome.failures.map((f) => f.path)).toEqual([blocked]);
    expect(removed.length).toBe(plan.targets.length - 1);
  });

  it("strips the PATH block from the rc file", () => {
    const plan = buildUninstallPlan(
      makeParams({
        scopes: ["path"],
        readFile: () => `\n${PATH_MARKER}\nexport PATH="x:$PATH"\n`,
      }),
    );
    const { deps, written } = makeDeps();
    const outcome = runUninstall(plan, deps);
    expect(outcome.edited.length).toBeGreaterThan(0);
    expect(written[0]?.[1]).not.toContain(PATH_MARKER);
  });

  it("does nothing at all for an empty plan", () => {
    const plan = buildUninstallPlan(makeParams({ exists: () => false }));
    const { deps, removed, written } = makeDeps();
    const outcome = runUninstall(plan, deps);
    expect(removed).toHaveLength(0);
    expect(written).toHaveLength(0);
    expect(outcome.removed).toHaveLength(0);
  });
});
