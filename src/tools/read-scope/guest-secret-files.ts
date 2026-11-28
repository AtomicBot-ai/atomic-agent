import { basename, isAbsolute, relative, resolve } from "node:path";

import { canonical } from "./read-scope.js";

/**
 * Files and folders a channel guest never sees, not even by name in a
 * walk (ATO-2703).
 *
 * `guest-reads.ts` refuses a guest's read that NAMES one of these, but a
 * recursive grep or glob of the working directory names only the folder,
 * so a nested `config/.env` would still come back in the results. The
 * walking tools therefore drop these entries themselves when the call
 * comes from a guest session (`ToolContext.guest`): `os.fs.grep` (also
 * passes the matching `--iglob !…` exclusions to ripgrep), `os.fs.glob`,
 * `os.fs.code_map`, `os.code.search` and `files.search`.
 *
 * Matched case-insensitively against a path's segments:
 *  - a file whose name looks like a secret: `.env`, `.env.*`, `.envrc`,
 *    private keys and keystores, credential files of common tools;
 *  - anything under a folder named like a credential store (`secrets`,
 *    `.ssh`, `.aws`, `.gnupg`, ...).
 *
 * Precedent: Claude Code's documented permission rules deny `Read` of
 * `./.env`, `./.env.*` and `./secrets/**`; gitleaks and GitHub's secret
 * scanning flag the same key and credential file names.
 */

/** Exact file names (lowercase). */
const SECRET_FILE_NAMES: ReadonlySet<string> = new Set([
  ".env",
  ".envrc",
  ".netrc",
  "_netrc",
  ".npmrc",
  ".pypirc",
  ".pgpass",
  ".git-credentials",
  ".htpasswd",
  "credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

/** File name prefixes (lowercase) of any extension: `.env.local`, `.env.production`. */
const SECRET_FILE_PREFIXES: readonly string[] = [".env."];

/**
 * File name prefixes (lowercase) that count only with a data extension:
 * `secrets.json`, `credentials.yml`, `secrets.enc.yaml`. Source files of
 * the same name (`credentials.ts`, `secrets.go`) are code, not secrets.
 */
const SECRET_DATA_PREFIXES: readonly string[] = ["secrets.", "credentials."];
const DATA_EXTENSIONS: readonly string[] = [
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "txt",
  "xml",
  "conf",
  "cfg",
  "properties",
  "env",
  "csv",
];

/** File extensions (lowercase) of private keys and keystores. */
const SECRET_FILE_EXTENSIONS: readonly string[] = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".ppk",
];

/** Folder names (lowercase) whose whole content is hidden. */
const SECRET_FOLDER_NAMES: ReadonlySet<string> = new Set([
  "secrets",
  ".secrets",
  ".ssh",
  ".aws",
  ".gnupg",
  ".docker",
  ".kube",
]);

/** True when a single file name looks like a secret. */
export function isSecretFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SECRET_FILE_NAMES.has(lower)) return true;
  if (SECRET_FILE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  if (
    SECRET_DATA_PREFIXES.some((prefix) => lower.startsWith(prefix)) &&
    DATA_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`))
  ) {
    return true;
  }
  return SECRET_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext) && lower.length > ext.length);
}

/** True when a single folder name is a credential store. */
export function isSecretFolderName(name: string): boolean {
  return SECRET_FOLDER_NAMES.has(name.toLowerCase());
}

/**
 * True when a RELATIVE path (`/` or `\` separated, `./` allowed) names a
 * secret-looking file or lies under a secret folder. Only the segments
 * of `rel` are checked, so the folders above the walk's root never count.
 */
export function isGuestSecretRelPath(rel: string): boolean {
  const segments = rel.split(/[\\/]+/).filter((s) => s.length > 0 && s !== ".");
  if (segments.length === 0) return false;
  const last = segments[segments.length - 1]!;
  if (isSecretFileName(last)) return true;
  return segments.some(isSecretFolderName);
}

/**
 * True when `path` (absolute, or relative to `root`) is a secret for a
 * guest, judged by its segments below `root`. A path outside `root` is
 * judged by its file name alone.
 */
export function isGuestSecretPathUnder(root: string, path: string): boolean {
  const rel = isAbsolute(path) ? relative(root, path) : path;
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
    return isSecretFileName(basename(path));
  }
  return isGuestSecretRelPath(rel);
}

/**
 * True when a hit a walking tool found (absolute, or relative to
 * `workingDir`) is a secret for a guest of `workingDir`. Judged against
 * both the lexical and the canonical working directory, as
 * `guest-reads.ts` does: an index stores real paths, so a hit under a
 * symlinked or differently cased working directory would otherwise look
 * like it lies outside it and be judged by its file name only.
 */
export function isGuestSecretHit(workingDir: string, path: string): boolean {
  const root = resolve(workingDir);
  const absolute = resolve(root, path);
  return isGuestSecretPathUnder(root, absolute) ||
    isGuestSecretPathUnder(canonical(root), canonical(absolute));
}

/**
 * ripgrep exclusions matching the rules above, for `--iglob` (case
 * insensitive). A glob without a slash matches a name at any depth, and
 * a later glob wins over an earlier one, so these go after the caller's
 * own `glob` entries: a guest's `glob: ".env"` cannot whitelist it back.
 */
export const GUEST_SECRET_RG_EXCLUDES: readonly string[] = [
  ...[...SECRET_FILE_NAMES].map((name) => `!${name}`),
  ...SECRET_FILE_PREFIXES.map((prefix) => `!${prefix}*`),
  ...SECRET_DATA_PREFIXES.flatMap((prefix) => [
    `!${prefix}{${DATA_EXTENSIONS.join(",")}}`,
    `!${prefix}*.{${DATA_EXTENSIONS.join(",")}}`,
  ]),
  ...SECRET_FILE_EXTENSIONS.map((ext) => `!*${ext}`),
  ...[...SECRET_FOLDER_NAMES].map((name) => `!${name}`),
];
