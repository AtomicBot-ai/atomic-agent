/**
 * Write a new version into package.json and package-lock.json, and change
 * nothing else (ATO-1641).
 *
 * `scripts/release.sh` used to run `npm install --package-lock-only` after
 * editing package.json. That re-resolves the whole tree with whatever npm
 * the release machine has, and an npm on macOS dropped the `libc` fields of
 * the Linux-only optional packages from the lock, so CI's `npm ci` on Linux
 * then installed the wrong prebuilds. A version bump only needs the two
 * `version` fields the lock copies from package.json: the top-level one and
 * the root package's (`packages[""]`). Both are rewritten as text, so the
 * lock's formatting and every other byte stay as they were.
 *
 * Usage: tsx scripts/bump-version.ts <dir> <X.Y.Z>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+$/;

export class BumpVersionError extends Error {}

/** package.json with its first (top-level) `"version"` replaced. */
export function bumpPackageJson(raw: string, version: string): string {
  assertSemver(version);
  const updated = raw.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`);
  const parsed = JSON.parse(updated) as { version?: unknown };
  if (parsed.version !== version) {
    throw new BumpVersionError("package.json has no top-level version field");
  }
  return updated;
}

/**
 * package-lock.json with the top-level `version` and `packages[""].version`
 * replaced, as text. Throws when the lock does not have the expected shape
 * (no root package, or a version field that does not sit where npm writes
 * it), so the release stops instead of committing a half-bumped lock.
 */
export function bumpPackageLock(raw: string, version: string): string {
  assertSemver(version);
  // npm writes "name", then "version", then "lockfileVersion" at the top,
  // and inside packages[""] "name" then "version". Take the first version
  // after each anchor.
  let updated = replaceAfter(raw, /^\{\s*"name":\s*"[^"]*",\s*/, version, "top-level");
  updated = replaceAfter(
    updated,
    /"packages":\s*\{\s*"":\s*\{\s*"name":\s*"[^"]*",\s*/,
    version,
    'packages[""]',
  );

  const before = JSON.parse(raw) as LockShape;
  const after = JSON.parse(updated) as LockShape;
  if (after.version !== version || after.packages?.[""]?.version !== version) {
    throw new BumpVersionError("package-lock.json version fields were not updated");
  }
  // Nothing but the two version fields may differ.
  after.version = before.version;
  if (after.packages?.[""] && before.packages?.[""]) {
    after.packages[""].version = before.packages[""].version;
  }
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new BumpVersionError("package-lock.json changed beyond its version fields");
  }
  return updated;
}

interface LockShape {
  version?: unknown;
  packages?: Record<string, { version?: unknown }>;
}

function replaceAfter(raw: string, anchor: RegExp, version: string, where: string): string {
  const match = anchor.exec(raw);
  if (!match) {
    throw new BumpVersionError(`package-lock.json: cannot find the ${where} package entry`);
  }
  const start = match.index + match[0].length;
  const rest = raw.slice(start);
  const field = /^"version":\s*"[^"]*"/.exec(rest);
  if (!field) {
    throw new BumpVersionError(`package-lock.json: no version right after the ${where} name`);
  }
  return raw.slice(0, start) + `"version": "${version}"` + rest.slice(field[0].length);
}

function assertSemver(version: string): void {
  if (!SEMVER.test(version)) {
    throw new BumpVersionError(`version must be X.Y.Z, got ${JSON.stringify(version)}`);
  }
}

/** Bump both files under `dir`. */
export function bumpVersionFiles(dir: string, version: string): void {
  const pkgPath = join(dir, "package.json");
  const lockPath = join(dir, "package-lock.json");
  // Compute both before writing either, so a bad lock leaves both untouched.
  const pkg = bumpPackageJson(readFileSync(pkgPath, "utf8"), version);
  const lock = bumpPackageLock(readFileSync(lockPath, "utf8"), version);
  writeFileSync(pkgPath, pkg);
  writeFileSync(lockPath, lock);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [dir, version] = process.argv.slice(2);
  if (!dir || !version) {
    console.error("Usage: tsx scripts/bump-version.ts <dir> <X.Y.Z>");
    process.exit(1);
  }
  try {
    bumpVersionFiles(dir, version);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
