import { describe, expect, it } from "vitest";

import { restrictWindowsAcl, type WindowsAclDeps } from "./windows-acl.js";

const PATH = "C:\\Users\\u\\.atomic-agent\\.env";

function makeDeps(overrides: Partial<WindowsAclDeps> = {}): {
  deps: WindowsAclDeps;
  icaclsCalls: string[][];
  probeCalls: string[];
} {
  const icaclsCalls: string[][] = [];
  const probeCalls: string[] = [];
  const deps: WindowsAclDeps = {
    platform: "win32",
    username: () => "u",
    runIcacls: (args) => {
      icaclsCalls.push(args);
    },
    probeRead: (path) => {
      probeCalls.push(path);
    },
    ...overrides,
  };
  return { deps, icaclsCalls, probeCalls };
}

describe("restrictWindowsAcl", () => {
  it("is a no-op off Windows", () => {
    const { deps, icaclsCalls, probeCalls } = makeDeps({ platform: "darwin" });
    restrictWindowsAcl(PATH, deps);
    expect(icaclsCalls).toEqual([]);
    expect(probeCalls).toEqual([]);
  });

  it("tightens the ACL and verifies the file is still readable", () => {
    const { deps, icaclsCalls, probeCalls } = makeDeps();
    restrictWindowsAcl(PATH, deps);
    expect(icaclsCalls).toEqual([
      [PATH, "/inheritance:r", "/grant:r", "u:F"],
    ]);
    expect(probeCalls).toEqual([PATH]);
  });

  it("rolls back with /reset when the tightened ACL locks this process out", () => {
    const { deps, icaclsCalls } = makeDeps({
      probeRead: () => {
        throw new Error("EPERM: operation not permitted");
      },
    });
    restrictWindowsAcl(PATH, deps);
    expect(icaclsCalls).toEqual([
      [PATH, "/inheritance:r", "/grant:r", "u:F"],
      [PATH, "/reset"],
    ]);
  });

  it("still probes when icacls itself fails, but skips reset when readable", () => {
    const { deps, probeCalls, icaclsCalls } = makeDeps();
    deps.runIcacls = (args) => {
      icaclsCalls.push(args);
      throw new Error("icacls not found");
    };
    restrictWindowsAcl(PATH, deps);
    // Only the tighten attempt; the file stayed readable so no reset.
    expect(icaclsCalls).toEqual([[PATH, "/inheritance:r", "/grant:r", "u:F"]]);
    expect(probeCalls).toEqual([PATH]);
  });

  it("never throws even when tighten, probe, and reset all fail", () => {
    const { deps } = makeDeps({
      runIcacls: () => {
        throw new Error("icacls exploded");
      },
      probeRead: () => {
        throw new Error("EPERM");
      },
    });
    expect(() => restrictWindowsAcl(PATH, deps)).not.toThrow();
  });

  it("does nothing when the username is unavailable", () => {
    const { deps, icaclsCalls } = makeDeps({
      username: () => {
        throw new Error("no user database");
      },
    });
    restrictWindowsAcl(PATH, deps);
    expect(icaclsCalls).toEqual([]);
  });

  it("does nothing when the username is empty", () => {
    const { deps, icaclsCalls } = makeDeps({ username: () => "" });
    restrictWindowsAcl(PATH, deps);
    expect(icaclsCalls).toEqual([]);
  });
});
