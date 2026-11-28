/**
 * Whether a plain `git push` also pushes submodules, each to its own
 * remote, which the egress scan does not read (review rounds 2 and 3 of
 * ATO-2528). Read the way git 2.39 reads it, checked against system git:
 *
 * - `push.recurseSubmodules` and `submodule.recurse` set the same thing,
 *   and the one read last (system, global, repository, worktree config,
 *   in file order) wins: `push.recurseSubmodules=no` then
 *   `submodule.recurse=true` pushes the submodules.
 * - `submodule.recurse` is a git bool: `2`, `0x1`, `1k`, `YES` and a bare
 *   key are true.
 * - `check` only checks that the submodules were pushed, so it sends
 *   nothing; `on-demand` and `only` push them. A value git rejects stops
 *   the push, so holding it costs one question and nothing else.
 *
 * A push only recurses where there are submodules, so a repository with
 * no `.gitmodules`, no `modules` folder and no submodule in its index is
 * not held. Residue: a submodule that only a commit being pushed adds,
 * with no trace in the index or the folder.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_INDEX_BYTES = 64 * 1024 * 1024;

/**
 * git's bool: `true`/`yes`/`on`, a nonzero integer (`0x1`, `010`, `1k`),
 * or a key with no `=` (read as `"true"`); `false`/`no`/`off`, zero or
 * empty. `undefined` for a value git rejects.
 */
export function gitBool(value: string): boolean | undefined {
  const word = value.trim().toLowerCase();
  if (word === "true" || word === "yes" || word === "on") return true;
  if (word === "false" || word === "no" || word === "off" || word === "") return false;
  const number = /^[+-]?(0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*)[kmg]?$/.exec(word);
  if (number === null) return undefined;
  return /[1-9a-f]/.test((number[1] ?? "").replace(/^0x/, ""));
}

/** Whether one setting of `key` (lower case) to `value` makes a push recurse. */
export function recursesFor(key: string, value: string): boolean {
  if (key === "submodule.recurse") return gitBool(value) !== false;
  if (value === "check") return false;
  return gitBool(value) !== false;
}

/** The last `push.recursesubmodules` or `submodule.recurse` in read order decides. */
export function pushesSubmodules(entries: readonly (readonly [string, string])[]): boolean {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const [key, value] = entries[i]!;
    if (key === "push.recursesubmodules" || key === "submodule.recurse") return recursesFor(key, value);
  }
  return false;
}

/**
 * Whether the index lists a submodule (a gitlink), or cannot be read
 * plainly: too large, an unknown version, a sparse directory entry or a
 * split index whose entries live in another file.
 */
function indexMayHaveGitlink(path: string, oidBytes: number): boolean {
  let data: Buffer;
  try {
    if (!existsSync(path)) return false;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) return true;
    data = readFileSync(path);
  } catch {
    return true;
  }
  if (data.length < 12 || data.toString("latin1", 0, 4) !== "DIRC") return true;
  const version = data.readUInt32BE(4);
  if (version < 2 || version > 4) return true;
  const count = data.readUInt32BE(8);
  let at = 12;
  for (let n = 0; n < count; n += 1) {
    const flagsAt = at + 40 + oidBytes;
    if (flagsAt + 2 > data.length) return true;
    const type = data.readUInt32BE(at + 24) & 0o170000;
    if (type === 0o160000 || type === 0o040000) return true;
    let name = flagsAt + 2 + ((data.readUInt16BE(flagsAt) & 0x4000) !== 0 ? 2 : 0);
    if (version === 4) {
      while (name < data.length && (data[name]! & 0x80) !== 0) name += 1;
      name += 1;
    }
    const end = data.indexOf(0, name);
    if (end === -1) return true;
    at = version === 4 ? end + 1 : at + ((end - at + 8) & ~7);
  }
  while (at + 8 <= data.length - oidBytes) {
    if (data.toString("latin1", at, at + 4) === "link") return true;
    at += 8 + data.readUInt32BE(at + 4);
  }
  return false;
}

export interface SubmoduleRepo {
  workTree: string;
  gitDir: string;
  commonDir: string;
}

/** Whether `repo` may have a submodule a recursing push would send. */
export function repoMayHaveSubmodules(repo: SubmoduleRepo, objectFormat: string | undefined): boolean {
  if (existsSync(join(repo.workTree, ".gitmodules"))) return true;
  if (existsSync(join(repo.commonDir, "modules"))) return true;
  const format = (objectFormat ?? "sha1").toLowerCase();
  if (format !== "sha1" && format !== "sha256") return true;
  return indexMayHaveGitlink(join(repo.gitDir, "index"), format === "sha256" ? 32 : 20);
}
