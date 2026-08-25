import { describe, expect, it } from "vitest";

import {
  isInstalledBinary,
  isSafeToRemove,
  planUninstallTargets,
  type UninstallPlanInput,
} from "./uninstall-targets.js";

function input(overrides: Partial<UninstallPlanInput> = {}): UninstallPlanInput {
  return {
    stateDir: "/Users/op/.atomic-agent",
    execPath: "/Users/op/.local/bin/atomic-agent",
    homeDir: "/Users/op",
    platform: "darwin",
    binaryPresent: true,
    ...overrides,
  };
}

describe("planUninstallTargets", () => {
  it("lists the state dir and the debug bundles as data", () => {
    const data = planUninstallTargets(input()).filter((t) => t.group === "data");
    expect(data.map((t) => t.path)).toEqual([
      "/Users/op/.atomic-agent",
      "/Users/op/Documents/atomic-agent-debug",
    ]);
  });

  it("lists the binary, the alias and every installer asset dir", () => {
    const program = planUninstallTargets(input())
      .filter((t) => t.group === "program")
      .map((t) => t.path);
    expect(program).toEqual([
      "/Users/op/.local/bin/atomic-agent",
      "/Users/op/.local/bin/atag",
      "/Users/op/.local/bin/grammars",
      "/Users/op/.local/bin/starter-skills",
      "/Users/op/.local/bin/assets",
      "/Users/op/.local/bin/vendor",
      "/Users/op/.local/bin/prebuilds",
      "/Users/op/.local/bin/node_modules",
    ]);
  });

  it("uses .exe names on windows", () => {
    const program = planUninstallTargets(
      input({
        platform: "win32",
        execPath: "C:\\Users\\op\\bin\\atomic-agent.exe",
        homeDir: "C:\\Users\\op",
      }),
    ).filter((t) => t.group === "program");
    expect(program.slice(0, 2).map((t) => t.path.replace(/\\/g, "/"))).toEqual([
      "C:/Users/op/bin/atomic-agent.exe",
      "C:/Users/op/bin/atag.exe",
    ]);
  });

  it("plans data only under a dev runtime", () => {
    const targets = planUninstallTargets(
      input({ execPath: "/usr/local/bin/node" }),
    );
    expect(targets.every((t) => t.group === "data")).toBe(true);
  });

  it("plans data only when the binary is not where execPath says", () => {
    const targets = planUninstallTargets(input({ binaryPresent: false }));
    expect(targets.every((t) => t.group === "data")).toBe(true);
  });

  it("honours a relocated state dir", () => {
    const [first] = planUninstallTargets(input({ stateDir: "/opt/aa-state" }));
    expect(first?.path).toBe("/opt/aa-state");
  });
});

describe("isInstalledBinary", () => {
  it.each([
    ["/Users/op/.local/bin/atomic-agent", true],
    ["/Users/op/.local/bin/atomic-agent.exe", true],
    ["/usr/local/bin/node", false],
    ["/usr/local/bin/node22", false],
    ["/opt/homebrew/bin/tsx", false],
  ])("%s -> %s", (execPath, expected) => {
    expect(isInstalledBinary(execPath)).toBe(expected);
  });
});

describe("isSafeToRemove", () => {
  const home = "/Users/op";

  it("accepts the paths the plan actually names", () => {
    expect(isSafeToRemove("/Users/op/.atomic-agent", home)).toBe(true);
    expect(isSafeToRemove("/Users/op/.local/bin/atag", home)).toBe(true);
    expect(isSafeToRemove("/opt/aa-state", home)).toBe(true);
  });

  it("refuses the home directory itself", () => {
    expect(isSafeToRemove(home, home)).toBe(false);
    expect(isSafeToRemove("/Users/op/", home)).toBe(false);
  });

  it("refuses the filesystem root", () => {
    expect(isSafeToRemove("/", home)).toBe(false);
  });

  it("refuses a one-segment system directory", () => {
    expect(isSafeToRemove("/usr", home)).toBe(false);
    expect(isSafeToRemove("/etc", home)).toBe(false);
  });
});
