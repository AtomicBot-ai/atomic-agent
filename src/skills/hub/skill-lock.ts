import { createHash } from "node:crypto";
import { readdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillScanVerdict } from "./skill-security-scanner.js";

/**
 * Per-skill lock file for skills installed from a hub (GitHub tap or
 * ClawHub). It records where the skill came from, the exact version that
 * was security-scanned, and a sha256 digest of every installed file, so
 * `skill update` can:
 *  - ask the same source whether a newer version exists;
 *  - tell a skill the operator edited by hand (digest mismatch) from the
 *    pristine install, and never overwrite the edited one.
 *
 * The file sits inside the skill folder and is left out of the digest.
 * Local-folder installs never carry one (see `installLocalSkill`), so a
 * folder cannot claim a hub origin it does not have.
 */
export const SKILL_LOCK_FILE = ".atomic-skill-lock.json";

export type SkillLockSource = "github" | "clawhub";

/** Where a staged skill came from and which exact version was fetched. */
export interface SkillOrigin {
  source: SkillLockSource;
  /** Identifier as given to the installer (`owner/repo/path[@ref]`, `@owner/slug`). */
  identifier: string;
  /**
   * The exact version that was downloaded and scanned: the commit sha
   * (GitHub) or the registry version (ClawHub). Empty when the source
   * could not say; the digest still pins the bytes.
   */
  version: string;
  /**
   * GitHub only: git tree sha of the skill folder at `version`. It moves
   * only when the skill's own files change, unlike the commit sha.
   */
  revision?: string;
}

export interface SkillLock extends SkillOrigin {
  schema: 1;
  /** {@link computeSkillDigest} of the folder right after install. */
  digest: string;
  /** `scanIdOf` of the scan that approved this version. */
  scanId: string;
  verdict: SkillScanVerdict;
  /** ISO timestamp of the install. */
  installedAt: string;
}

/**
 * sha256 over the sorted list of files in `dir`: for each regular file
 * its relative path and the sha256 of its bytes, for each symlink its
 * relative path and link text. The lock file at the root is excluded.
 * Empty folders do not count. Same bytes always give the same digest.
 */
export async function computeSkillDigest(dir: string): Promise<string> {
  const lines: string[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    const entries = await readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = join(abs, entry.name);
      if (childRel === SKILL_LOCK_FILE) continue;
      if (entry.isSymbolicLink()) {
        lines.push(`l ${childRel}\0${await readlink(childAbs)}`);
      } else if (entry.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (entry.isFile()) {
        const hash = createHash("sha256")
          .update(await readFile(childAbs))
          .digest("hex");
        lines.push(`f ${childRel}\0${hash}`);
      }
    }
  }
  await walk(dir, "");
  const digest = createHash("sha256").update(lines.join("\n")).digest("hex");
  return `sha256-${digest}`;
}

/** Read and validate a skill's lock file; null when absent or malformed. */
export async function readSkillLock(skillDir: string): Promise<SkillLock | null> {
  let raw: string;
  try {
    raw = await readFile(join(skillDir, SKILL_LOCK_FILE), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isSkillLock(parsed) ? parsed : null;
}

/** Write the lock file atomically (temp file, then rename). */
export async function writeSkillLock(
  skillDir: string,
  lock: SkillLock,
): Promise<void> {
  const target = join(skillDir, SKILL_LOCK_FILE);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

/** Drop a lock file a source folder may have shipped with. */
export async function removeSkillLock(skillDir: string): Promise<void> {
  await rm(join(skillDir, SKILL_LOCK_FILE), { force: true });
}

function isSkillLock(value: unknown): value is SkillLock {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.schema === 1 &&
    (v.source === "github" || v.source === "clawhub") &&
    typeof v.identifier === "string" &&
    v.identifier.length > 0 &&
    typeof v.version === "string" &&
    (v.revision === undefined || typeof v.revision === "string") &&
    typeof v.digest === "string" &&
    typeof v.scanId === "string" &&
    (v.verdict === "ok" || v.verdict === "caution" || v.verdict === "dangerous") &&
    typeof v.installedAt === "string"
  );
}
