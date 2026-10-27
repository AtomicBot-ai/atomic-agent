/**
 * The apt and dnf repository (REPOSITORY in linux-packaging.ts: a public Hetzner Object Storage
 * bucket) of both products, the CLI (`vX.Y.Z` releases) and the desktop app (`desktop-vX.Y.Z`).
 * GitHub Releases are the source of truth: the repository is rebuilt from scratch out of the
 * newest releases' packages of each product on every release, signed, and mirrored to the bucket,
 * so a failed or repeated run never leaves state to repair. The pure parts (products, which
 * releases, layout, upload order) are in linux-packaging.ts.
 *
 *   npx tsx scripts/linux-repo.ts release --tag TAG                                # does TAG go in? (workflow outputs)
 *   npx tsx scripts/linux-repo.ts latest --product cli|desktop                     # the product's newest release tag
 *   npx tsx scripts/linux-repo.ts fetch --out dl [--keep 10]                      # packages of each window, checked
 *   npx tsx scripts/linux-repo.ts build --assets dl --key FPR --out site [--base-url URL]
 *                                      [--publish-keys FPR,FPR] [--unsigned-packages]
 *   npx tsx scripts/linux-repo.ts sync --site site [--bucket NAME --endpoint URL --region R] [--dry-run]
 *   npx tsx scripts/linux-repo.ts readme --block apt|dnf [--base-url URL]         # the README's commands
 *
 * `release`, `latest` and `fetch` need `gh` (GH_TOKEN); `build` needs dpkg-scanpackages,
 * apt-ftparchive, createrepo_c, rpmsign and gpg (the key's passphrase, if any, in
 * LINUX_PACKAGES_GPG_PASSPHRASE); `sync` needs the aws CLI with the bucket's credentials in
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
  parseProductId,
  parseSha256File,
  parseSha256Sums,
  PRODUCTS,
  productOfTag,
  readmeInstallBlock,
  REPOSITORY,
  renderRepoFile,
  repoPath,
  selectReleases,
  SHA256SUMS_FILE,
  syncPlan,
  type GithubRelease,
  type Product,
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

function listReleases(): GithubRelease[] {
  const pages = JSON.parse(
    run("gh", ["api", "--paginate", "--slurp", `repos/${GITHUB_REPO}/releases?per_page=100`]),
  ) as GithubRelease[][];
  return pages.flat();
}

/**
 * Whether a tag's release goes into the repository, as the workflow's outputs: tag, version,
 * product (cli | desktop, empty for a tag of neither), the package and AUR names, publish.
 */
function release(): void {
  const tag = option("tag");
  if (!tag) fail("release needs --tag <release tag>");
  const match = productOfTag(tag);
  let reason: string | undefined;
  if (!match) {
    reason = `${tag} is not a stable vX.Y.Z or desktop-vX.Y.Z tag`;
  } else {
    const info = JSON.parse(
      run("gh", ["release", "view", tag, "--repo", GITHUB_REPO, "--json", "isDraft,isPrerelease,assets"]),
    ) as { isDraft: boolean; isPrerelease: boolean; assets: Array<{ name: string }> };
    if (info.isDraft) reason = `${tag} is a draft`;
    else if (info.isPrerelease) reason = `${tag} is a pre-release`;
    else if (!info.assets.some((a) => match.product.file.test(a.name))) {
      reason = `${tag} has no ${match.product.name} packages`;
    }
  }
  if (reason) stderr.write(`linux-repo: ${reason}; the repository stays as it is\n`);
  const lines = [
    `tag=${tag}`,
    `version=${match?.version ?? ""}`,
    `product=${match?.product.id ?? ""}`,
    `package=${match?.product.name ?? ""}`,
    `aur=${match?.product.aur ?? ""}`,
    `publish=${reason === undefined}`,
  ];
  stdout.write(`${lines.join("\n")}\n`);
}

/** The newest published stable release of a product that carries packages: its tag. */
function latest(): void {
  const product = PRODUCTS[parseProductId(option("product"))];
  const [newest] = selectReleases(listReleases(), 1, product);
  if (!newest) fail(`no published stable ${product.name} release carries packages`);
  stdout.write(`${newest.tag}\n`);
}

/** The digests a release lists in its SHA256SUMS.txt, by file name. */
function readSha256Sums(dir: string, tag: string): Record<string, string> {
  const path = join(dir, SHA256SUMS_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    fail(`${tag} has no ${SHA256SUMS_FILE}; the desktop release must list its packages' digests`);
  }
  rmSync(path);
  return parseSha256Sums(text);
}

function fetchProduct(product: Product, releases: GithubRelease[], out: string, keep: number): number {
  let count = 0;
  for (const { tag } of selectReleases(releases, keep, product)) {
    const dir = join(out, tag);
    // The packages and their digests: a .sha256 beside each (the CLI) or one SHA256SUMS.txt (the
    // desktop, whose release is assembled by hand from the desktop workflow's artifacts).
    const patterns = product.patterns.flatMap((p) => ["-p", p]);
    run("gh", ["release", "download", tag, "--repo", GITHUB_REPO, "--dir", dir, ...patterns]);
    const packages = readdirSync(dir).filter((f) => product.file.test(f));
    if (packages.length === 0) fail(`${tag} has no ${product.name} packages`);
    const sums = product.digests === "sha256sums" ? readSha256Sums(dir, tag) : undefined;
    for (const file of packages) {
      let digest: string | undefined;
      if (sums) {
        digest = sums[file];
        if (!digest) fail(`${tag}/${SHA256SUMS_FILE} does not list ${file}`);
      } else {
        digest = parseSha256File(readFileSync(join(dir, `${file}.sha256`), "utf8"), file);
        rmSync(join(dir, `${file}.sha256`));
      }
      if (digest !== sha256(join(dir, file))) fail(`${tag}/${file} does not match its digest`);
    }
    count += packages.length;
    stdout.write(`${tag}: ${packages.join(", ")}\n`);
  }
  return count;
}

function fetchReleases(): void {
  const out = resolve(option("out", "dl"));
  const keep = Number(option("keep", "10"));
  const releases = listReleases();
  rmSync(out, { recursive: true, force: true });
  let count = 0;
  for (const product of Object.values(PRODUCTS)) {
    count += fetchProduct(product, releases, out, keep);
  }
  if (count === 0) fail("no published stable release carries packages");
}

function gpg(args: string[], input?: string): string {
  const pass = env.LINUX_PACKAGES_GPG_PASSPHRASE;
  const prefix = ["--batch", "--yes", "--pinentry-mode", "loopback"];
  return run("gpg", [...prefix, ...(pass ? ["--passphrase-fd", "0"] : []), ...args], {
    input: pass ? `${pass}\n${input ?? ""}` : input,
  });
}

type Sign = (args: string[]) => string;

/**
 * Sign the rpms that arrived unsigned (the desktop's: electron-builder signs no rpm; the CLI's come
 * signed from nfpm) with the packages key, since the .repo file asks dnf to check every package.
 * rpmsign runs gpg itself; the passphrase reaches it through a file that lives for this call.
 */
function signUnsignedRpms(site: string, key: string): void {
  const dir = join(site, "rpm", "packages");
  const unsigned = readdirSync(dir)
    .filter((f) => f.endsWith(".rpm"))
    .map((f) => join(dir, f))
    .filter((f) => run("rpm", ["-qp", "--qf", "%{SIGPGP:pgpsig}", f]).trim() === "(none)");
  if (unsigned.length === 0) return;
  const defines = ["--define", `_gpg_name ${key}`];
  const pass = env.LINUX_PACKAGES_GPG_PASSPHRASE;
  const passDir = pass ? mkdtempSync(join(tmpdir(), "rpmsign-")) : undefined;
  if (pass && passDir) {
    writeFileSync(join(passDir, "pass"), `${pass}\n`, { mode: 0o600 });
    defines.push(
      "--define",
      `_gpg_sign_cmd_extra_args --pinentry-mode loopback --passphrase-file ${join(passDir, "pass")}`,
    );
  }
  try {
    run("rpmsign", [...defines, "--addsign", ...unsigned]);
  } finally {
    if (passDir) rmSync(passDir, { recursive: true, force: true });
  }
  stdout.write(`signed ${unsigned.length} rpm(s) that arrived unsigned\n`);
}

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
  if (packageSignatures) signUnsignedRpms(site, key);
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
if (command === "release") release();
else if (command === "latest") latest();
else if (command === "fetch") fetchReleases();
else if (command === "build") build();
else if (command === "sync") sync();
else if (command === "readme") readme();
else fail("usage: linux-repo.ts release|latest|fetch|build|sync|readme [options]; see the header of this file");
