import { execFileSync } from "node:child_process";

import {
  WINDOWS_ARM64_BACKEND_ASSET,
  WINDOWS_ARM64_COMPAT_BACKEND_ASSET,
} from "./platform-assets.js";

/**
 * ATO-253: which Windows on ARM build a machine gets.
 *
 * The engine release carries two arm64 zips. The fast one is compiled
 * with `-march=armv8.7-a` and uses the int8 matrix multiply (I8MM) and
 * BF16 instructions; on a Snapdragon 8cx Gen 1-3 (Surface Pro X, Windows
 * Dev Kit 2023), which stop at armv8.2, it dies on the first matmul with
 * an illegal instruction. The compat zip (`armv8.2-a+dotprod`) runs on
 * all of them. So the fast build is only for a CPU that proves it has
 * both instructions, and every doubt goes to compat.
 *
 * The proof is the CPU's own feature register. Windows copies the arm64
 * ID registers of each core into the registry as `CP <encoding>` QWORDs
 * under `CentralProcessor\<n>`; `CP 4031` is `ID_AA64ISAR1_EL1`
 * (op0=3, op1=0, CRn=0, CRm=6, op2=1). Its BF16 field is bits [47:44] and
 * its I8MM field bits [55:52]; nonzero means present. Reading the
 * register, not the processor name, also gets virtual machines right:
 * a VM on a host without I8MM reports what its guest really has.
 * One `reg query` (a few tens of ms) per process, cached.
 */
export type ArmFeatureSupport = "yes" | "no" | "unknown";

const CPU_REGISTRY_KEY = "HKLM\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0";
const ISAR1_VALUE = "CP 4031";

const BF16_SHIFT = 44n;
const I8MM_SHIFT = 52n;
const FIELD_MASK = 0xfn;

/**
 * The value of `valueName` in `reg query` output, or null when the line
 * is missing or is not a REG_QWORD. Pure.
 */
export function parseRegQword(output: string, valueName: string): bigint | null {
  for (const line of output.split(/\r?\n/)) {
    const [name, type, value] = line.trim().split(/\s{2,}|\t+/);
    if (name === undefined || type === undefined || value === undefined) continue;
    if (name.toLowerCase() !== valueName.toLowerCase()) continue;
    if (type.toUpperCase() !== "REG_QWORD") return null;
    const hex = value.match(/^0x([0-9a-f]+)$/i)?.[1];
    return hex === undefined ? null : BigInt(`0x${hex}`);
  }
  return null;
}

/**
 * Whether `ID_AA64ISAR1_EL1` shows both I8MM and BF16. An all-zero value
 * is "unknown", not "no": every armv8.2 core sets some field of this
 * register, so zero means the register was not really read. Pure.
 */
export function armv87FeaturesFromIsar1(isar1: bigint | null): ArmFeatureSupport {
  if (isar1 === null || isar1 === 0n) return "unknown";
  const i8mm = (isar1 >> I8MM_SHIFT) & FIELD_MASK;
  const bf16 = (isar1 >> BF16_SHIFT) & FIELD_MASK;
  return i8mm !== 0n && bf16 !== 0n ? "yes" : "no";
}

/** Read `CP 4031` of CPU 0, or null when `reg` fails or prints no such value. */
export function readWindowsIsar1(): bigint | null {
  try {
    const out = execFileSync(
      "reg",
      ["query", CPU_REGISTRY_KEY, "/v", ISAR1_VALUE],
      { timeout: 4000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    ).toString();
    return parseRegQword(out, ISAR1_VALUE);
  } catch {
    return null;
  }
}

let cachedSupport: ArmFeatureSupport | null = null;

/** Does this CPU run the armv8.7 build? Probed once per process. */
export function detectWindowsArm64FastBuildSupport(): ArmFeatureSupport {
  if (cachedSupport === null) {
    cachedSupport = armv87FeaturesFromIsar1(readWindowsIsar1());
  }
  return cachedSupport;
}

/** Test helper: forget the probe. */
export function resetWindowsArm64CpuCache(): void {
  cachedSupport = null;
}

/**
 * The arm64 zips this machine can use, best first. Pure.
 *
 * - "yes": the fast build, and compat for a release that lacks it.
 * - "unknown" (the probe failed): compat first; the fast build only for a
 *   release that has no compat zip, since it may well run and there is
 *   nothing else to try.
 * - "no": compat only. The fast build is certain to crash here, so a
 *   release without compat is a release with nothing for this machine.
 */
export function windowsArm64AssetPreference(
  support: ArmFeatureSupport,
): [string, ...string[]] {
  if (support === "yes") {
    return [WINDOWS_ARM64_BACKEND_ASSET, WINDOWS_ARM64_COMPAT_BACKEND_ASSET];
  }
  if (support === "unknown") {
    return [WINDOWS_ARM64_COMPAT_BACKEND_ASSET, WINDOWS_ARM64_BACKEND_ASSET];
  }
  return [WINDOWS_ARM64_COMPAT_BACKEND_ASSET];
}
