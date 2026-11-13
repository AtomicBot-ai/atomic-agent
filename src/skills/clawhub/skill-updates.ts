import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  GithubSkillClient,
  type SkillHubClient,
} from "../hub/github-skill-client.js";
import {
  commitStagedInstall,
  discardStagedInstall,
  enforceScanGate,
  stageSkillFromHub,
  type ScanGateOptions,
  type StagedSkillInstall,
} from "../hub/install-from-hub.js";
import { parseSkillIdentifier } from "../hub/skill-hub-source.js";
import {
  computeSkillDigest,
  readSkillLock,
  type SkillLock,
} from "../hub/skill-lock.js";
import type { SkillScanResult } from "../hub/skill-security-scanner.js";
import { ClawHubClient } from "./clawhub-client.js";
import { parseClawHubIdentifier } from "./clawhub-source.js";
import { resolveLatestVersion, stageSkillFromClawHub } from "./install-from-clawhub.js";

/**
 * Update hub-installed skills (GitHub taps and ClawHub) in place.
 *
 * Only skills with a lock file (`skill-lock.ts`) are tracked: local
 * folders and starter skills are never touched here. The rules:
 *  - a skill whose files no longer match the digest recorded at install
 *    was edited by hand; it is reported and never overwritten;
 *  - a new version is staged in a temp dir and goes through the same
 *    security scan and gate as a first install; a refused scan leaves the
 *    installed copy untouched;
 *  - the previous copy is moved to `backupRoot/<name>` before the new one
 *    goes in, and put back if the swap fails; {@link rollbackSkillUpdate}
 *    restores it later.
 * Nothing here runs on its own: callers (the CLI) decide when to check,
 * and an update replaces a skill only after the person agreed to it
 * (`confirmUpdate`, or `skill update --yes`).
 */

export type SkillUpdateState =
  | "up_to_date"
  | "update_available"
  | "locally_modified"
  | "error";

export interface SkillUpdateStatus {
  name: string;
  source: SkillLock["source"];
  identifier: string;
  installedVersion: string;
  /** Latest version the source reported; absent on `error`. */
  latestVersion?: string;
  state: SkillUpdateState;
  /** True when a newer version exists but the skill was edited locally. */
  updateBlocked?: boolean;
  error?: string;
}

export interface SkillUpdateSources {
  github?: SkillHubClient;
  clawhub?: ClawHubClient;
  /** Temp root for staged downloads (tests). */
  tmpRoot?: string;
}

export interface CheckSkillUpdatesOptions extends SkillUpdateSources {
  targetRoot: string;
  /** Only these skills; default every tracked skill under `targetRoot`. */
  names?: readonly string[];
}

export async function checkSkillUpdates(
  options: CheckSkillUpdatesOptions,
): Promise<SkillUpdateStatus[]> {
  const root = resolve(options.targetRoot);
  const names = options.names ?? (await listSkillDirs(root));
  const out: SkillUpdateStatus[] = [];
  for (const name of names) {
    const dir = join(root, name);
    const lock = await readSkillLock(dir);
    if (!lock) continue;
    const base = {
      name,
      source: lock.source,
      identifier: lock.identifier,
      installedVersion: lock.version,
    };
    try {
      const modified = (await computeSkillDigest(dir)) !== lock.digest;
      const latest = await latestRevision(lock, options);
      const newer = isNewer(lock, latest);
      const status: SkillUpdateStatus = {
        ...base,
        latestVersion: latest.version,
        state: modified ? "locally_modified" : newer ? "update_available" : "up_to_date",
      };
      if (modified && newer) status.updateBlocked = true;
      out.push(status);
    } catch (err) {
      out.push({ ...base, state: "error", error: errorText(err) });
    }
  }
  return out;
}

export type SkillUpdateErrorCode =
  | "not_tracked"
  | "locally_modified"
  | "name_changed"
  | "no_backup";

export class SkillUpdateError extends Error {
  constructor(
    message: string,
    public readonly code: SkillUpdateErrorCode,
  ) {
    super(message);
    this.name = "SkillUpdateError";
  }
}

/** What an update would change, shown before anything is replaced. */
export interface SkillUpdatePreview {
  name: string;
  identifier: string;
  fromVersion: string;
  toVersion: string;
  scan: SkillScanResult;
}

export interface ApplySkillUpdateOptions extends SkillUpdateSources, ScanGateOptions {
  targetRoot: string;
  name: string;
  /** Where the previous copy is kept; see {@link defaultBackupRoot}. */
  backupRoot?: string;
  /**
   * Asked after the new version is staged and passed the scan gate, and
   * before the installed copy is touched. Returning false keeps the
   * installed version (`state: "declined"`). Omit it only when the
   * person already opted in (`skill update --yes`).
   */
  confirmUpdate?: (preview: SkillUpdatePreview) => Promise<boolean>;
}

export interface ApplySkillUpdateResult {
  name: string;
  state: "updated" | "up_to_date" | "declined";
  fromVersion: string;
  toVersion: string;
  scan?: SkillScanResult;
  /** Folder holding the previous copy after an update. */
  backupPath?: string;
}

/**
 * Stage the latest version of one tracked skill, re-scan it, and swap it
 * in only if the scan gate passes. Throws {@link SkillUpdateError} for an
 * untracked or locally edited skill, and the gate's
 * `SkillHubInstallError` when the scan refuses (old copy kept).
 */
export async function applySkillUpdate(
  options: ApplySkillUpdateOptions,
): Promise<ApplySkillUpdateResult> {
  const root = resolve(options.targetRoot);
  const dir = join(root, options.name);
  const lock = await readSkillLock(dir);
  if (!lock) {
    throw new SkillUpdateError(
      `${options.name} was not installed from a skill hub; nothing to update`,
      "not_tracked",
    );
  }
  if ((await computeSkillDigest(dir)) !== lock.digest) {
    throw new SkillUpdateError(
      `${options.name} was changed locally since it was installed; not overwriting it (reinstall with --force to discard the changes)`,
      "locally_modified",
    );
  }
  const staged = await stageFromLock(lock, options);
  const toVersion = staged.origin?.version ?? "";
  try {
    if ((await computeSkillDigest(staged.sourceDir)) === lock.digest) {
      await discardStagedInstall(staged);
      return { name: options.name, state: "up_to_date", fromVersion: lock.version, toVersion };
    }
    if (staged.manifest.name !== options.name) {
      throw new SkillUpdateError(
        `the new version of ${options.name} is named "${staged.manifest.name}"; not replacing it`,
        "name_changed",
      );
    }
    await enforceScanGate(lock.identifier, staged.scan, options);
    if (options.confirmUpdate) {
      const yes = await options.confirmUpdate({
        name: options.name,
        identifier: lock.identifier,
        fromVersion: lock.version,
        toVersion,
        scan: staged.scan,
      });
      if (!yes) {
        await discardStagedInstall(staged);
        return { name: options.name, state: "declined", fromVersion: lock.version, toVersion, scan: staged.scan };
      }
    }
  } catch (err) {
    await discardStagedInstall(staged);
    throw err;
  }

  const backupRoot = resolve(options.backupRoot ?? defaultBackupRoot(root));
  const backupPath = join(backupRoot, options.name);
  await mkdir(backupRoot, { recursive: true });
  await rm(backupPath, { recursive: true, force: true });
  await moveDir(dir, backupPath);
  try {
    await commitStagedInstall(staged, { targetRoot: root });
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await moveDir(backupPath, dir);
    throw err;
  }
  return {
    name: options.name,
    state: "updated",
    fromVersion: lock.version,
    toVersion,
    scan: staged.scan,
    backupPath,
  };
}

export interface RollbackSkillUpdateOptions {
  targetRoot: string;
  name: string;
  backupRoot?: string;
}

/**
 * Swap the installed copy with the one kept by the last update. Running
 * it twice returns to the updated version.
 */
export async function rollbackSkillUpdate(
  options: RollbackSkillUpdateOptions,
): Promise<{ name: string; restoredFrom: string }> {
  const root = resolve(options.targetRoot);
  const dir = join(root, options.name);
  const backupRoot = resolve(options.backupRoot ?? defaultBackupRoot(root));
  const backupPath = join(backupRoot, options.name);
  if (!(await isDir(backupPath))) {
    throw new SkillUpdateError(
      `no previous copy of ${options.name} to roll back to`,
      "no_backup",
    );
  }
  const aside = join(backupRoot, `${options.name}.swap-${Date.now()}`);
  const hadCurrent = await isDir(dir);
  if (hadCurrent) await moveDir(dir, aside);
  await moveDir(backupPath, dir);
  if (hadCurrent) await moveDir(aside, backupPath);
  return { name: options.name, restoredFrom: backupPath };
}

/**
 * Previous copies live next to the skills folder, never inside it: the
 * loader would pick up any folder with a SKILL.md as a second skill.
 */
export function defaultBackupRoot(targetRoot: string): string {
  return join(dirname(resolve(targetRoot)), "skill-backups");
}

interface LatestRevision {
  version: string;
  revision?: string;
}

async function latestRevision(
  lock: SkillLock,
  sources: SkillUpdateSources,
): Promise<LatestRevision> {
  if (lock.source === "clawhub") {
    const ref = parseClawHubIdentifier(lock.identifier);
    const version = await resolveLatestVersion(sources.clawhub ?? new ClawHubClient(), ref);
    if (!version) throw new Error(`ClawHub did not report a version for ${lock.identifier}`);
    return { version };
  }
  const id = parseSkillIdentifier(lock.identifier);
  const client = sources.github ?? new GithubSkillClient();
  if (!client.resolveSkillRevision) {
    throw new Error("this GitHub client cannot resolve skill versions");
  }
  const ref = id.ref ?? (await client.resolveDefaultBranch(id.owner, id.repo));
  const rev = await client.resolveSkillRevision(id.owner, id.repo, ref, id.path);
  return { version: rev.commit, ...(rev.tree ? { revision: rev.tree } : {}) };
}

/**
 * GitHub: the skill folder's tree sha when both sides have it (a commit
 * elsewhere in the repo is not an update), else the commit. ClawHub: the
 * registry version. An install with no recorded version always counts as
 * outdated, so the next update pins it.
 */
function isNewer(lock: SkillLock, latest: LatestRevision): boolean {
  if (lock.revision && latest.revision) return lock.revision !== latest.revision;
  return lock.version === "" || lock.version !== latest.version;
}

async function stageFromLock(
  lock: SkillLock,
  sources: SkillUpdateSources,
): Promise<StagedSkillInstall> {
  if (lock.source === "clawhub") {
    return stageSkillFromClawHub({
      identifier: lock.identifier,
      ...(sources.clawhub ? { client: sources.clawhub } : {}),
      ...(sources.tmpRoot ? { tmpRoot: sources.tmpRoot } : {}),
    });
  }
  return stageSkillFromHub({
    identifier: lock.identifier,
    ...(sources.github ? { client: sources.github } : {}),
    ...(sources.tmpRoot ? { tmpRoot: sources.tmpRoot } : {}),
  });
}

async function listSkillDirs(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

async function moveDir(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await cp(from, to, { recursive: true, verbatimSymlinks: true });
    await rm(from, { recursive: true, force: true });
  }
}

async function isDir(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() === true;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
