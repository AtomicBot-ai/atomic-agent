/**
 * The URL `git push` would send to, read from the repository's own config
 * files without running git (ATO-2116), so the approval card can say
 * `sends data to -> github.com` rather than `git remote "origin"`.
 *
 * Read only where the answer is plain: any `insteadOf` / `pushInsteadOf`
 * rewrite (in the repository or the user's global config) or any
 * `include` makes the URL something this reader cannot be sure of, and
 * the answer is `null`, which the gate treats as an unknown destination.
 * Every error (no repository, unreadable file, too large) is `null` too.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_WALK_UP = 64;

/** A parsed git config: `section.subsection.key` (section and key lower case) to its values. */
export type GitConfig = Map<string, string[]>;

export function parseGitConfig(text: string): GitConfig {
  const config: GitConfig = new Map();
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (header !== null) {
      const name = (header[1] ?? "").toLowerCase();
      const sub = header[2];
      section = sub === undefined ? name : `${name}.${sub.replace(/\\(.)/g, "$1")}`;
      continue;
    }
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (entry === null || section === "") continue;
    const key = `${section}.${(entry[1] ?? "").toLowerCase()}`;
    const value = unquote(entry[2] ?? "true");
    const list = config.get(key) ?? [];
    list.push(value);
    config.set(key, list);
  }
  return config;
}

function unquote(value: string): string {
  const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(value);
  if (quoted !== null) return (quoted[1] ?? "").replace(/\\(.)/g, "$1");
  return value.replace(/\s+[#;].*$/, "").trim();
}

function last(config: GitConfig, key: string): string | undefined {
  const values = config.get(key);
  return values === undefined ? undefined : values[values.length - 1];
}

/** Whether `config` rewrites URLs or pulls in other files, so its remote URLs are not plain. */
export function configIsIndirect(config: GitConfig): boolean {
  for (const key of config.keys()) {
    if (/^url\..*\.(?:insteadof|pushinsteadof)$/.test(key)) return true;
    if (key.startsWith("include.") || key.startsWith("includeif.")) return true;
  }
  return false;
}

function readSmall(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

interface RepoFiles {
  gitDir: string;
  commonDir: string;
}

/** The repository `start` is in: its git dir and the common dir that holds `config`. */
export function findRepository(start: string): RepoFiles | null {
  let dir = resolve(start);
  for (let i = 0; i < MAX_WALK_UP; i += 1) {
    const dotGit = join(dir, ".git");
    try {
      if (existsSync(dotGit)) {
        const stat = statSync(dotGit);
        let gitDir: string | null = null;
        if (stat.isDirectory()) gitDir = dotGit;
        else if (stat.isFile()) {
          const pointer = /^gitdir:\s*(.+)$/m.exec(readSmall(dotGit) ?? "");
          if (pointer !== null) gitDir = resolve(dir, (pointer[1] ?? "").trim());
        }
        if (gitDir === null) return null;
        const common = (readSmall(join(gitDir, "commondir")) ?? "").trim();
        return { gitDir, commonDir: common.length > 0 ? resolve(gitDir, common) : gitDir };
      }
    } catch {
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export interface GitRemoteUrlOptions {
  /** The user's global config files; a test seam. */
  globalConfigPaths?: readonly string[];
}

function defaultGlobalConfigPaths(): string[] {
  const home = homedir();
  const xdg = process.env.XDG_CONFIG_HOME;
  return [
    join(home, ".gitconfig"),
    join(xdg !== undefined && xdg.length > 0 ? xdg : join(home, ".config"), "git", "config"),
  ];
}

/** The first URL of `gitRemoteUrls`, or `null`. */
export function gitRemoteUrl(
  cwd: string,
  remote: string | null,
  options: GitRemoteUrlOptions = {},
): string | null {
  return gitRemoteUrls(cwd, remote, options)?.[0] ?? null;
}

/**
 * Every URL `git push [remote]` run in `cwd` sends to, or `null` when it
 * cannot be read plainly. `remote` `null` is the push default: the
 * branch's `pushRemote`, `remote.pushDefault`, the branch's `remote`,
 * then `origin`. Git pushes to each `pushurl` of the remote, or to each
 * `url` when it has none, so all of them are returned, in file order
 * (review round 1 of ATO-2528: only the last one was).
 */
export function gitRemoteUrls(
  cwd: string,
  remote: string | null,
  options: GitRemoteUrlOptions = {},
): string[] | null {
  const repo = findRepository(cwd);
  if (repo === null) return null;
  const text = readSmall(join(repo.commonDir, "config"));
  if (text === null) return null;
  const config = parseGitConfig(text);
  const worktreeText = readSmall(join(repo.gitDir, "config.worktree"));
  if (worktreeText !== null) {
    for (const [key, values] of parseGitConfig(worktreeText)) {
      config.set(key, [...(config.get(key) ?? []), ...values]);
    }
  }
  if (configIsIndirect(config)) return null;
  for (const path of options.globalConfigPaths ?? defaultGlobalConfigPaths()) {
    const global = readSmall(path);
    if (global !== null && configIsIndirect(parseGitConfig(global))) return null;
  }
  let name = remote;
  if (name === null) {
    const head = /^ref:\s*refs\/heads\/(.+)$/m.exec(readSmall(join(repo.gitDir, "HEAD")) ?? "");
    const branch = head === null ? undefined : (head[1] ?? "").trim();
    name =
      (branch !== undefined ? last(config, `branch.${branch}.pushremote`) : undefined) ??
      last(config, "remote.pushdefault") ??
      (branch !== undefined ? last(config, `branch.${branch}.remote`) : undefined) ??
      "origin";
  }
  const urls = config.get(`remote.${name}.pushurl`) ?? config.get(`remote.${name}.url`) ?? [];
  return urls.length > 0 ? [...urls] : null;
}
