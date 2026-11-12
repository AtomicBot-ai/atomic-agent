import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

import {
  WINDOWS_ARM64_BACKEND_ASSET,
  WINDOWS_ARM64_COMPAT_BACKEND_ASSET,
} from "./platform-assets.js";
import {
  armv87FeaturesFromIsar1,
  detectWindowsArm64FastBuildSupport,
  parseRegQword,
  readWindowsIsar1,
  resetWindowsArm64CpuCache,
  windowsArm64AssetPreference,
} from "./windows-arm64-backend-variant.js";

/**
 * `ID_AA64ISAR1_EL1` values, built from the Arm ARM field layout.
 * A76 / X1 class (Snapdragon 8cx Gen 1-3): DPB and LRCPC only.
 */
const ISAR1_ARMV82 = 0x0000_0000_0010_0001n;
/** Snapdragon X class: also BF16 (bits 47:44) and I8MM (bits 55:52). */
const ISAR1_ARMV87 = ISAR1_ARMV82 | (1n << 44n) | (1n << 52n);
/** I8MM without BF16. */
const ISAR1_I8MM_ONLY = ISAR1_ARMV82 | (1n << 52n);

function regOutput(value: string, type = "REG_QWORD"): string {
  return [
    "",
    "HKEY_LOCAL_MACHINE\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0",
    `    CP 4031    ${type}    ${value}`,
    "",
  ].join("\r\n");
}

describe("parseRegQword", () => {
  it("reads a REG_QWORD value line", () => {
    expect(parseRegQword(regOutput("0x10100001"), "CP 4031")).toBe(0x10100001n);
  });

  it("matches the value name case-insensitively", () => {
    expect(parseRegQword(regOutput("0x1"), "cp 4031")).toBe(1n);
  });

  it("returns null for another value, another type or no hex", () => {
    expect(parseRegQword(regOutput("0x1"), "CP 4030")).toBeNull();
    expect(parseRegQword(regOutput("0x1", "REG_SZ"), "CP 4031")).toBeNull();
    expect(parseRegQword(regOutput("garbage"), "CP 4031")).toBeNull();
    expect(parseRegQword("", "CP 4031")).toBeNull();
  });
});

describe("armv87FeaturesFromIsar1", () => {
  it("is yes only with both I8MM and BF16", () => {
    expect(armv87FeaturesFromIsar1(ISAR1_ARMV87)).toBe("yes");
    expect(armv87FeaturesFromIsar1(ISAR1_I8MM_ONLY)).toBe("no");
    expect(armv87FeaturesFromIsar1(ISAR1_ARMV82)).toBe("no");
  });

  it("is unknown when the register was not read", () => {
    expect(armv87FeaturesFromIsar1(null)).toBe("unknown");
    expect(armv87FeaturesFromIsar1(0n)).toBe("unknown");
  });
});

describe("windowsArm64AssetPreference", () => {
  it("puts the fast build first only for a CPU that proves it can run it", () => {
    expect(windowsArm64AssetPreference("yes")).toEqual([
      WINDOWS_ARM64_BACKEND_ASSET,
      WINDOWS_ARM64_COMPAT_BACKEND_ASSET,
    ]);
    expect(windowsArm64AssetPreference("unknown")).toEqual([
      WINDOWS_ARM64_COMPAT_BACKEND_ASSET,
      WINDOWS_ARM64_BACKEND_ASSET,
    ]);
  });

  it("never offers the fast build to a CPU without I8MM", () => {
    expect(windowsArm64AssetPreference("no")).toEqual([
      WINDOWS_ARM64_COMPAT_BACKEND_ASSET,
    ]);
  });
});

describe("detectWindowsArm64FastBuildSupport", () => {
  beforeEach(() => {
    resetWindowsArm64CpuCache();
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    resetWindowsArm64CpuCache();
  });

  it("queries CP 4031 of CPU 0 with reg", () => {
    execFileSyncMock.mockReturnValue(
      Buffer.from(regOutput(`0x${ISAR1_ARMV87.toString(16)}`)),
    );
    expect(readWindowsIsar1()).toBe(ISAR1_ARMV87);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "reg",
      [
        "query",
        "HKLM\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0",
        "/v",
        "CP 4031",
      ],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it("says yes on a Snapdragon X class register, probing once", () => {
    execFileSyncMock.mockReturnValue(
      Buffer.from(regOutput(`0x${ISAR1_ARMV87.toString(16)}`)),
    );
    expect(detectWindowsArm64FastBuildSupport()).toBe("yes");
    expect(detectWindowsArm64FastBuildSupport()).toBe("yes");
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it("says no on an 8cx class register", () => {
    execFileSyncMock.mockReturnValue(
      Buffer.from(regOutput(`0x${ISAR1_ARMV82.toString(16)}`)),
    );
    expect(detectWindowsArm64FastBuildSupport()).toBe("no");
  });

  it("says unknown when reg fails", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("ERROR: The system was unable to find the specified registry key or value.");
    });
    expect(detectWindowsArm64FastBuildSupport()).toBe("unknown");
  });
});
