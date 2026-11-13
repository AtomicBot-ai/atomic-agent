/**
 * Write and check atomic-agent's ACP registry entry (ATO-689). The entry's
 * content and the checks are in acp-registry-manifest.ts; how to submit it is
 * in packaging/acp-registry/README.md.
 *
 *   npx tsx scripts/acp-registry.ts manifest --version X.Y.Z [--archives bundle] [--out dist/acp-registry]
 *   npx tsx scripts/acp-registry.ts check [--dir dist/acp-registry/atomic-agent]
 *
 * `manifest` reads the release archives' `.sha256` digests (package-bundle.ts
 * writes them next to each archive; `gh release download vX.Y.Z -p '*.sha256'`
 * fetches a published release's) and writes `<out>/atomic-agent/agent.json`
 * and `icon.svg`: the folder to copy into a fork of
 * agentclientprotocol/registry. A platform whose digest is missing is left
 * out. It checks what it wrote and fails on a problem.
 *
 * `check` runs the same offline checks on a folder. Neither touches the
 * network or submits anything.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

import {
  ACP_AGENT_ID,
  archiveName,
  buildAcpManifest,
  renderAcpManifest,
  validateAcpIcon,
  validateAcpManifest,
} from "./acp-registry-manifest.js";
import { BUNDLE_TARGETS } from "./bundle-targets.js";
import { parseSha256File } from "./linux-packaging.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ICON = join(ROOT, "packaging", "acp-registry", "icon.svg");

function fail(message: string): never {
  stderr.write(`acp-registry: ${message}\n`);
  exit(1);
}

function option(name: string, fallback: string): string;
function option(name: string): string | undefined;
function option(name: string, fallback?: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) fail(`--${name} needs a value`);
  return value;
}

function checkFolder(dir: string): void {
  const manifestPath = join(dir, "agent.json");
  const iconPath = join(dir, "icon.svg");
  if (!existsSync(manifestPath)) fail(`${manifestPath} is missing`);
  if (!existsSync(iconPath)) fail(`${iconPath} is missing (the registry requires an icon)`);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const errors = [
    ...validateAcpManifest(manifest, basename(resolve(dir))),
    ...validateAcpIcon(readFileSync(iconPath, "utf8")),
  ];
  if (errors.length > 0) fail(`${dir} would fail the registry's checks:\n  ${errors.join("\n  ")}`);
  stdout.write(`${dir}: agent.json and icon.svg pass the registry's offline checks\n`);
}

function manifest(): void {
  const version = option("version");
  if (!version) fail("manifest needs --version X.Y.Z");
  const archives = resolve(option("archives", join(ROOT, "bundle")));
  const out = join(resolve(option("out", join(ROOT, "dist", "acp-registry"))), ACP_AGENT_ID);
  const sha256: Record<string, string> = {};
  for (const target of BUNDLE_TARGETS) {
    const name = archiveName(target);
    const digest = join(archives, `${name}.sha256`);
    if (!existsSync(digest)) {
      stderr.write(`acp-registry: no ${name}.sha256 in ${archives}, ${target.slug} left out\n`);
      continue;
    }
    sha256[target.slug] = parseSha256File(readFileSync(digest, "utf8"), name);
  }
  let text: string;
  try {
    text = renderAcpManifest(buildAcpManifest({ version, sha256 }));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "agent.json"), text, "utf8");
  copyFileSync(ICON, join(out, "icon.svg"));
  stdout.write(`wrote ${join(out, "agent.json")} and icon.svg\n`);
  checkFolder(out);
}

const command = argv[2];
if (command === "manifest") manifest();
else if (command === "check") checkFolder(resolve(option("dir", join(ROOT, "dist", "acp-registry", ACP_AGENT_ID))));
else fail("usage: acp-registry.ts manifest|check [options]; see the header of this file");
