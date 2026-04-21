/**
 * Prints the bundling matrix as JSON — CI consumes this to spin up one
 * build job per (platform, arch). Node SEA cannot cross-compile, so CI
 * pins each job to a runner that matches the target triple.
 *
 * Usage:
 *   npx tsx scripts/print-matrix.ts          # human-readable
 *   npx tsx scripts/print-matrix.ts --json   # machine-readable for GH Actions
 */
import { argv, stdout } from "node:process";
import { BUNDLE_TARGETS } from "./bundle-targets.js";

interface MatrixEntry {
  slug: string;
  os: string;
  platform: string;
  arch: string;
  executable: string;
  archiveExt: string;
}

const RUNNER_OS: Record<string, string> = {
  "darwin-arm64": "macos-14",
  "darwin-x64": "macos-13",
  "linux-x64": "ubuntu-22.04",
  "linux-arm64": "ubuntu-22.04-arm",
  "win32-x64": "windows-2022",
};

function buildMatrix(): MatrixEntry[] {
  return BUNDLE_TARGETS.map((t) => ({
    slug: t.slug,
    os: RUNNER_OS[t.slug] ?? "self-hosted",
    platform: t.platform,
    arch: t.arch,
    executable: t.executableName,
    archiveExt: t.archiveExt,
  }));
}

function main(): void {
  const asJson = argv.includes("--json");
  const matrix = buildMatrix();
  if (asJson) {
    stdout.write(`${JSON.stringify({ include: matrix })}\n`);
    return;
  }
  stdout.write("Bundle matrix:\n");
  for (const entry of matrix) {
    stdout.write(
      `  ${entry.slug.padEnd(14)} runner=${entry.os.padEnd(18)} arch=${entry.arch.padEnd(6)} archive=${entry.archiveExt}\n`,
    );
  }
}

main();
