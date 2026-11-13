/**
 * Writes the tap's formula or cask for a published release (the rendering is
 * in homebrew-packaging.ts; the commit to the tap in
 * .github/workflows/homebrew.yml).
 *
 *   npx tsx scripts/homebrew.ts render --tag v0.7.1 --assets dl --tap tap
 *   npx tsx scripts/homebrew.ts render --tag desktop-v0.0.9 --assets dl --tap tap
 *
 * `--assets` holds what `gh release download` fetched: for a CLI release the
 * `atomic-agent-darwin-<arch>.tar.gz.sha256` files, for a desktop release its
 * `SHA256SUMS.txt`. `--tap` is a checkout of the tap; the file is written
 * there unless the tap already carries a newer version (a re-run for an old
 * tag must not downgrade anyone). Prints `path=…` and `written=true|false`,
 * for $GITHUB_OUTPUT.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { parseArgs } from "node:util";

import {
  CASK_PATH,
  FORMULA_PATH,
  cliArchive,
  compareVersions,
  desktopDmg,
  parseDigestFile,
  parseReleaseTag,
  parseSha256Sums,
  renderCask,
  renderFormula,
  renderedVersion,
  type ArchDigests,
  type MacArch,
} from "./homebrew-packaging.js";

const ARCHES: readonly MacArch[] = ["arm64", "x64"];

function cliDigests(assets: string): ArchDigests {
  const digests: ArchDigests = {};
  for (const arch of ARCHES) {
    const file = join(assets, `${cliArchive(arch)}.sha256`);
    if (existsSync(file)) digests[arch] = parseDigestFile(readFileSync(file, "utf8"));
  }
  return digests;
}

function desktopDigests(assets: string, version: string): ArchDigests {
  const file = join(assets, "SHA256SUMS.txt");
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  const sums = parseSha256Sums(readFileSync(file, "utf8"));
  const digests: ArchDigests = {};
  for (const arch of ARCHES) {
    const hash = sums.get(desktopDmg(version, arch));
    if (hash) digests[arch] = hash;
  }
  return digests;
}

function render(options: { tag: string; assets: string; tap: string }): number {
  const release = parseReleaseTag(options.tag);
  if (!release) {
    stderr.write(`${options.tag} is not a stable CLI (vX.Y.Z) or desktop (desktop-vX.Y.Z) release\n`);
    return 2;
  }
  const path = release.product === "cli" ? FORMULA_PATH : CASK_PATH;
  const ruby =
    release.product === "cli"
      ? renderFormula(release.version, cliDigests(options.assets))
      : renderCask(release.version, desktopDigests(options.assets, release.version));
  const target = join(options.tap, path);
  stdout.write(`path=${path}\n`);
  if (existsSync(target)) {
    const current = renderedVersion(readFileSync(target, "utf8"));
    if (current && /^\d+\.\d+\.\d+$/.test(current) && compareVersions(current, release.version) > 0) {
      stderr.write(`${path} already carries ${current}, newer than ${release.version}; left as is\n`);
      stdout.write("written=false\n");
      return 0;
    }
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, ruby, "utf8");
  stdout.write("written=true\n");
  return 0;
}

function main(): number {
  const [command, ...rest] = argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      tag: { type: "string" },
      assets: { type: "string" },
      tap: { type: "string" },
    },
  });
  if (command !== "render" || !values.tag || !values.assets || !values.tap) {
    stderr.write("usage: homebrew.ts render --tag <tag> --assets <dir> --tap <dir>\n");
    return 2;
  }
  return render({ tag: values.tag, assets: values.assets, tap: values.tap });
}

try {
  exit(main());
} catch (error) {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  exit(1);
}
