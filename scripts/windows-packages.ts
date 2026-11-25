/**
 * Writes the Scoop manifest and the winget manifests of a published release
 * (rendering in windows-packaging.ts; shipping in
 * .github/workflows/windows-packages.yml).
 *
 *   npx tsx scripts/windows-packages.ts scoop  --tag v0.7.1 --assets dl --bucket bucket-checkout
 *   npx tsx scripts/windows-packages.ts winget --tag v0.7.1 --assets dl --out winget
 *   npx tsx scripts/windows-packages.ts winget --tag desktop-v0.0.9 --assets dl --out winget
 *
 * `--assets` holds what `gh release download` fetched: for a CLI release
 * `atomic-agent-win32-x64.zip.sha256`, for a desktop release its
 * `SHA256SUMS.txt`. `scoop` writes bucket/atomic-agent.json into a checkout
 * of the bucket unless it already has a newer version; `winget` writes the
 * full manifests (the first submission to winget-pkgs is made from them) and
 * `<out>/wingetcreate-args.txt`, one argument per line, for
 * `wingetcreate update` on later releases. Both print key=value lines for
 * $GITHUB_OUTPUT.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { parseArgs } from "node:util";

import {
  CLI_ZIP,
  SCOOP_MANIFEST_PATH,
  WINGET_CLI_ID,
  WINGET_DESKTOP_ID,
  desktopInstaller,
  parseDigestFile,
  parseReleaseTag,
  parseSha256Sums,
  releaseUrl,
  renderScoopManifest,
  renderWingetCli,
  renderWingetDesktop,
  wingetManifestDir,
  wingetUpdateArgs,
  type WinArch,
  type WingetFile,
  type WingetInstaller,
} from "./windows-packaging.js";

function cliZipDigest(assets: string): string {
  const file = join(assets, `${CLI_ZIP}.sha256`);
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  return parseDigestFile(readFileSync(file, "utf8"));
}

function desktopDigests(assets: string, version: string): Partial<Record<WinArch, string>> {
  const file = join(assets, "SHA256SUMS.txt");
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  const sums = parseSha256Sums(readFileSync(file, "utf8"));
  const digests: Partial<Record<WinArch, string>> = {};
  for (const arch of ["x64", "arm64"] as const) {
    const hash = sums.get(desktopInstaller(version, arch));
    if (hash) digests[arch] = hash;
  }
  return digests;
}

function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

function scoop(tag: string, assets: string, bucket: string): number {
  const release = parseReleaseTag(tag);
  if (release?.product !== "cli") {
    stderr.write(`${tag} is not a stable CLI release (vX.Y.Z); Scoop carries the CLI only\n`);
    return 2;
  }
  const target = join(bucket, SCOOP_MANIFEST_PATH);
  stdout.write(`path=${SCOOP_MANIFEST_PATH}\n`);
  if (existsSync(target)) {
    const current = (JSON.parse(readFileSync(target, "utf8")) as { version?: unknown }).version;
    if (typeof current === "string" && newer(current, release.version)) {
      stderr.write(`${SCOOP_MANIFEST_PATH} already carries ${current}; left as is\n`);
      stdout.write("written=false\n");
      return 0;
    }
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderScoopManifest(release.version, cliZipDigest(assets)), "utf8");
  stdout.write("written=true\n");
  return 0;
}

function winget(tag: string, assets: string, out: string): number {
  const release = parseReleaseTag(tag);
  if (!release) {
    stderr.write(`${tag} is not a stable CLI or desktop release\n`);
    return 2;
  }
  let id: string;
  let files: WingetFile[];
  let installers: WingetInstaller[];
  if (release.product === "cli") {
    const sha256 = cliZipDigest(assets);
    id = WINGET_CLI_ID;
    files = renderWingetCli(release.version, sha256);
    installers = [{ arch: "x64", url: releaseUrl(tag, CLI_ZIP), sha256 }];
  } else {
    const digests = desktopDigests(assets, release.version);
    id = WINGET_DESKTOP_ID;
    files = renderWingetDesktop(release.version, digests);
    installers = (["x64", "arm64"] as const)
      .filter((arch) => digests[arch])
      .map((arch) => ({
        arch,
        url: releaseUrl(tag, desktopInstaller(release.version, arch)),
        sha256: digests[arch]!,
      }));
  }
  for (const file of files) {
    const path = join(out, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.text, "utf8");
  }
  writeFileSync(
    join(out, "wingetcreate-args.txt"),
    `${wingetUpdateArgs(id, release.version, installers).join("\n")}\n`,
    "utf8",
  );
  stdout.write(`id=${id}\nversion=${release.version}\ndir=${wingetManifestDir(id, release.version)}\n`);
  return 0;
}

function main(): number {
  const [command, ...rest] = argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      tag: { type: "string" },
      assets: { type: "string" },
      bucket: { type: "string" },
      out: { type: "string" },
    },
  });
  if (command === "scoop" && values.tag && values.assets && values.bucket) {
    return scoop(values.tag, values.assets, values.bucket);
  }
  if (command === "winget" && values.tag && values.assets && values.out) {
    return winget(values.tag, values.assets, values.out);
  }
  stderr.write(
    "usage: windows-packages.ts scoop --tag vX.Y.Z --assets <dir> --bucket <dir>\n" +
      "       windows-packages.ts winget --tag <tag> --assets <dir> --out <dir>\n",
  );
  return 2;
}

try {
  exit(main());
} catch (error) {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  exit(1);
}
