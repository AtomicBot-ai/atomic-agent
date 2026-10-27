/**
 * The apt and dnf repository (REPOSITORY in linux-packaging.ts: a public Hetzner Object Storage
 * bucket). GitHub Releases are the source of truth: the repository is rebuilt from scratch out of
 * the newest releases' packages on every release, signed, and mirrored to the bucket, so a failed
 * or repeated run never leaves state to repair. The pure parts (which releases, layout, upload
 * order) are in linux-packaging.ts.
 *
 *   npx tsx scripts/linux-repo.ts fetch --out dl [--keep 10]                      # packages of the window, checked
 *   npx tsx scripts/linux-repo.ts build --assets dl --key FPR --out site [--base-url URL]
 *                                      [--publish-keys FPR,FPR] [--unsigned-packages]
 *   npx tsx scripts/linux-repo.ts sync --site site [--bucket NAME --endpoint URL --region R] [--dry-run]
 *   npx tsx scripts/linux-repo.ts readme --block apt|dnf [--base-url URL]         # the README's commands
 *
 * `fetch` needs `gh` (GH_TOKEN); `build` needs dpkg-scanpackages, apt-ftparchive, createrepo_c and
 * gpg (the key's passphrase, if any, in LINUX_PACKAGES_GPG_PASSPHRASE); `sync` needs the aws CLI
 * with the bucket's credentials in AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { argv, env, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  contentType,
  GITHUB_REPO,
  isPackageFile,
  KEY_FILE,
  PACKAGE_NAME,
  PACKAGE_TARGETS,
  parseSha256File,
  readmeInstallBlock,
  REPOSITORY,
  renderRepoFile,
  repoPath,
  selectReleases,
  syncPlan,
  type GithubRelease,
} from "./linux-packaging.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BASE_URL: string = REPOSITORY.baseUrl;

function fail(message: string): never {
  stderr.write(`linux-repo: ${message}\n`);
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

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): string {
  const res = spawnSync(command, args, { encoding: "utf8", maxBuffer: 1 << 28, ...options });
  if (res.error) fail(`${command}: ${res.error.message}`);
  if (res.status !== 0) fail(`${command} ${args.join(" ")} failed:\n${res.stderr ?? ""}`);
  return res.stdout;
}

/** Every file under `dir`, as forward-slash paths relative to it. */
function walk(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((p) => statSync(join(dir, p)).isFile())
    .map((p) => p.split(sep).join("/"));
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

function fetchReleases(): void {
  const out = resolve(option("out", "dl"));
  const keep = Number(option("keep", "10"));
  const pages = JSON.parse(
    run("gh", ["api", "--paginate", "--slurp", `repos/${GITHUB_REPO}/releases?per_page=100`]),
  ) as GithubRelease[][];
  const window = selectReleases(pages.flat(), keep);
  if (window.length === 0) fail("no published stable release carries packages");
  rmSync(out, { recursive: true, force: true });
  for (const { tag } of window) {
    const dir = join(out, tag);
    // The packages and their digests: atomic-agent_<v>_<arch>.<fmt> and the same with .sha256.
    run("gh", ["release", "download", tag, "--repo", GITHUB_REPO, "--dir", dir, "-p", `${PACKAGE_NAME}_*`]);
    for (const file of readdirSync(dir).filter(isPackageFile)) {
      const digest = parseSha256File(readFileSync(join(dir, `${file}.sha256`), "utf8"), file);
      if (digest !== sha256(join(dir, file))) fail(`${tag}/${file} does not match its .sha256`);
      rmSync(join(dir, `${file}.sha256`));
    }
    stdout.write(`${tag}: ${readdirSync(dir).join(", ")}\n`);
  }
}

function gpg(args: string[], input?: string): string {
  const pass = env.LINUX_PACKAGES_GPG_PASSPHRASE;
  const prefix = ["--batch", "--yes", "--pinentry-mode", "loopback"];
  return run("gpg", [...prefix, ...(pass ? ["--passphrase-fd", "0"] : []), ...args], {
    input: pass ? `${pass}\n${input ?? ""}` : input,
  });
}

type Sign = (args: string[]) => string;

function buildDeb(site: string, sign: Sign): void {
  const deb = join(site, "deb");
  const dist = join(deb, "dists", "stable");
  const arches = PACKAGE_TARGETS.map((t) => t.deb);
  for (const arch of arches) {
    const index = run("dpkg-scanpackages", ["--multiversion", "--arch", arch, "pool"], { cwd: deb });
    const dir = join(dist, "main", `binary-${arch}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Packages"), index);
    writeFileSync(join(dir, "Packages.gz"), gzipSync(index, { level: 9 }));
  }
  const release = run(
    "apt-ftparchive",
    [
      ...["-o", "APT::FTPArchive::Release::Origin=Atomic Agent"],
      ...["-o", `APT::FTPArchive::Release::Label=${PACKAGE_NAME}`],
      ...["-o", "APT::FTPArchive::Release::Suite=stable"],
      ...["-o", "APT::FTPArchive::Release::Codename=stable"],
      ...["-o", `APT::FTPArchive::Release::Architectures=${arches.join(" ")}`],
      ...["-o", "APT::FTPArchive::Release::Components=main"],
      "release",
      "dists/stable",
    ],
    { cwd: deb },
  );
  writeFileSync(join(dist, "Release"), release);
  sign(["--clearsign", "--output", join(dist, "InRelease"), join(dist, "Release")]);
  sign(["--armor", "--detach-sign", "--output", join(dist, "Release.gpg"), join(dist, "Release")]);
}

function buildRpm(site: string, sign: Sign, options: { baseUrl: string; packageSignatures: boolean }): void {
  const rpm = join(site, "rpm");
  // gzip metadata: RHEL 8's dnf cannot read the zstd that newer createrepo_c defaults to. The
  // metadata files keep their checksum in the name, so new ones never overwrite what the old
  // repomd.xml lists.
  run("createrepo_c", ["--general-compress-type=gz", rpm]);
  sign([
    "--armor",
    "--detach-sign",
    "--output",
    join(rpm, "repodata", "repomd.xml.asc"),
    join(rpm, "repodata", "repomd.xml"),
  ]);
  writeFileSync(join(rpm, `${PACKAGE_NAME}.repo`), renderRepoFile(options));
}

function build(): void {
  const assets = resolve(option("assets", "dl"));
  const site = resolve(option("out", "site"));
  const key = option("key");
  if (!key) fail("build needs --key <fingerprint of the signing key>");
  const baseUrl = option("base-url", BASE_URL).replace(/\/$/, "");
  const publishKeys = option("publish-keys", key).split(",");
  const packageSignatures = !argv.includes("--unsigned-packages");

  rmSync(site, { recursive: true, force: true });
  const files = walk(assets).filter((p) => isPackageFile(p.split("/").pop() ?? ""));
  if (!files.some((f) => f.endsWith(".deb")) || !files.some((f) => f.endsWith(".rpm"))) {
    fail(`${assets} has no deb or no rpm packages`);
  }
  const seen = new Set<string>();
  for (const file of files) {
    const name = file.split("/").pop()!;
    if (seen.has(name)) fail(`${name} appears twice under ${assets}`);
    seen.add(name);
    const target = join(site, repoPath(name));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(assets, file), target);
  }
  const sign: Sign = (args) => gpg(["--local-user", key, ...args]);
  buildDeb(site, sign);
  buildRpm(site, sign, { baseUrl, packageSignatures });
  writeFileSync(join(site, `${KEY_FILE}.asc`), run("gpg", ["--armor", "--export", ...publishKeys]));
  const binary = spawnSync("gpg", ["--export", ...publishKeys]);
  if (binary.status !== 0 || binary.stdout.length === 0) {
    fail(`gpg could not export ${publishKeys.join(", ")}`);
  }
  writeFileSync(join(site, `${KEY_FILE}.gpg`), binary.stdout);
  stdout.write(`built ${site}: ${seen.size} packages, signed by ${key}\n`);
}

function sync(): void {
  const site = resolve(option("site", "site"));
  const bucket = option("bucket", REPOSITORY.bucket);
  const endpoint = option("endpoint", REPOSITORY.endpoint);
  // Newer aws CLIs add checksums by default that not every S3-compatible store accepts; only send
  // what is required.
  const awsEnv: NodeJS.ProcessEnv = {
    ...env,
    AWS_DEFAULT_REGION: option("region", REPOSITORY.region),
    AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
    AWS_RESPONSE_CHECKSUM_VALIDATION: "when_required",
  };
  const aws = (args: string[]): string => run("aws", [...args, "--endpoint-url", endpoint], { env: awsEnv });
  const listing = JSON.parse(
    aws(["s3api", "list-objects-v2", "--bucket", bucket, "--output", "json"]) || "{}",
  ) as { Contents?: Array<{ Key: string }> };
  const remote = (listing.Contents ?? []).map((o) => o.Key);
  const plan = syncPlan(walk(site), remote);
  for (const step of plan) {
    stdout.write(`${step.op} ${step.path}\n`);
    if (argv.includes("--dry-run")) continue;
    if (step.op === "delete") {
      aws(["s3", "rm", `s3://${bucket}/${step.path}`, "--only-show-errors"]);
    } else {
      // Each object is public-read: the bucket itself stays private (no listing, no anonymous
      // writes), and the repository needs no setting outside this script.
      aws([
        ...["s3", "cp", join(site, step.path), `s3://${bucket}/${step.path}`, "--only-show-errors"],
        ...["--acl", "public-read"],
        ...["--cache-control", step.cacheControl, "--content-type", contentType(step.path)],
      ]);
    }
  }
  stdout.write(`synced ${relative(process.cwd(), site) || "."} to ${bucket}: ${plan.length} steps\n`);
}

function readme(): void {
  const block = option("block");
  if (!block) fail("readme needs --block apt|dnf");
  const text = readmeInstallBlock(readFileSync(join(ROOT, "README.md"), "utf8"), block);
  stdout.write(text.replaceAll(BASE_URL, option("base-url", BASE_URL).replace(/\/$/, "")));
}

const command = argv[2];
if (command === "fetch") fetchReleases();
else if (command === "build") build();
else if (command === "sync") sync();
else if (command === "readme") readme();
else fail("usage: linux-repo.ts fetch|build|sync|readme [options]; see the header of this file");
