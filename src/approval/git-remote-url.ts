/**
 * The URL `git push` would send to, read from the git config files
 * without running git (ATO-2116), so the approval card can say `sends
 * data to → github.com` rather than `git remote "origin"`.
 *
 * Every level git reads is merged, in git's order (review round 2 of
 * ATO-2528: `git config --global remote.origin.pushurl <evil>` went
 * unseen): the system config, the global one (XDG, then `~/.gitconfig`,
 * or `GIT_CONFIG_GLOBAL`), the repository's, then the worktree's.
 * `insteadOf` / `pushInsteadOf` rewrites are applied the way `git push`
 * applies them. Read only where the answer is plain: an `include`, or a
 * config given through the environment (`GIT_CONFIG_COUNT`,
 * `GIT_CONFIG_PARAMETERS`), makes the URL something this reader cannot
 * be sure of, and the answer is `null`, which the gate treats as an
 * unknown destination. Every error (no repository, unreadable file, too
 * large) is `null` too.
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

/** Whether `config` pulls in other files, so its remote URLs are not plain. */
export function configIsIndirect(config: GitConfig): boolean {
  for (const key of config.keys()) {
    if (key.startsWith("include.") || key.startsWith("includeif.")) return true;
  }
  return false;
}

/**
 * `url` rewritten by the longest matching `url.<base>.<kind>` prefix, as
 * git does; `undefined` when none matches.
 */
function rewrite(config: GitConfig, url: string, kind: "insteadof" | "pushinsteadof"): string | undefined {
  let best: { from: string; base: string } | undefined;
  for (const [key, values] of config) {
    const match = /^url\.(.*)\.(insteadof|pushinsteadof)$/.exec(key);
    if (match === null || match[2] !== kind) continue;
    for (const from of values) {
      if (from.length > 0 && url.startsWith(from) && (best === undefined || from.length > best.from.length)) {
        best = { from, base: match[1] ?? "" };
      }
    }
  }
  return best === undefined ? undefined : best.base + url.slice(best.from.length);
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
  /** The user's global config files, in the order git reads them; a test seam. */
  globalConfigPaths?: readonly string[];
  /** The system config files; a test seam. */
  systemConfigPaths?: readonly string[];
  /** The environment git would run with; a test seam. */
  env?: NodeJS.ProcessEnv;
}

function defaultGlobalConfigPaths(env: NodeJS.ProcessEnv): string[] {
  const override = env.GIT_CONFIG_GLOBAL;
  if (override !== undefined) return override.length > 0 ? [override] : [];
  const home = homedir();
  const xdg = env.XDG_CONFIG_HOME;
  return [
    join(xdg !== undefined && xdg.length > 0 ? xdg : join(home, ".config"), "git", "config"),
    join(home, ".gitconfig"),
  ];
}

/**
 * Where git builds look for the system config: the usual prefixes of
 * the system, Homebrew, Xcode's command line tools and Git for Windows.
 * Each one that exists is read; one this list misses is the residue.
 */
function defaultSystemConfigPaths(env: NodeJS.ProcessEnv): string[] {
  if (/^(?:1|true|yes|on)$/i.test(env.GIT_CONFIG_NOSYSTEM ?? "")) return [];
  if (env.GIT_CONFIG_SYSTEM !== undefined) return env.GIT_CONFIG_SYSTEM.length > 0 ? [env.GIT_CONFIG_SYSTEM] : [];
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  return [
    "/etc/gitconfig",
    "/usr/local/etc/gitconfig",
    "/opt/homebrew/etc/gitconfig",
    "/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig",
    "/Applications/Xcode.app/Contents/Developer/usr/share/git-core/gitconfig",
    join(programFiles, "Git", "etc", "gitconfig"),
    ...(env.PROGRAMDATA !== undefined ? [join(env.PROGRAMDATA, "Git", "config")] : []),
  ];
}

/** Config git takes from the environment, which this reader does not follow. */
const ENV_CONFIG = /^(?:GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_CONFIG)$/;

/**
 * `push.recurseSubmodules` on (`on-demand`, `check`, `only`), or unset
 * with `submodule.recurse` true, which git reads as `on-demand`.
 */
function pushesSubmodules(config: GitConfig): boolean {
  const push = last(config, "push.recursesubmodules");
  if (push !== undefined) return !/^(?:no|false|0|off)$/i.test(push.trim());
  return /^(?:true|yes|on|1)$/i.test((last(config, "submodule.recurse") ?? "").trim());
}

/** `into` with `more`'s values after its own: a later level adds to a list and wins a single value. */
function mergeInto(into: GitConfig, more: GitConfig): void {
  for (const [key, values] of more) into.set(key, [...(into.get(key) ?? []), ...values]);
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
  const env = options.env ?? process.env;
  if (Object.keys(env).some((key) => ENV_CONFIG.test(key))) return null;
  const repo = findRepository(cwd);
  if (repo === null) return null;
  const text = readSmall(join(repo.commonDir, "config"));
  if (text === null) return null;
  const config: GitConfig = new Map();
  for (const path of [
    ...(options.systemConfigPaths ?? defaultSystemConfigPaths(env)),
    ...(options.globalConfigPaths ?? defaultGlobalConfigPaths(env)),
  ]) {
    const level = readSmall(path);
    if (level !== null) mergeInto(config, parseGitConfig(level));
  }
  mergeInto(config, parseGitConfig(text));
  const worktreeText = readSmall(join(repo.gitDir, "config.worktree"));
  if (worktreeText !== null) mergeInto(config, parseGitConfig(worktreeText));
  if (configIsIndirect(config)) return null;
  // Each submodule then goes to its own remote, which is not read here
  // (review round 2 of ATO-2528): unknown, so the push is held.
  if (pushesSubmodules(config)) return null;
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
  // `git push` sends to each pushurl (with `insteadOf` applied), or to
  // each url with `pushInsteadOf` applied, else `insteadOf`.
  const pushUrls = config.get(`remote.${name}.pushurl`);
  const urls =
    pushUrls !== undefined
      ? pushUrls.map((url) => rewrite(config, url, "insteadof") ?? url)
      : (config.get(`remote.${name}.url`) ?? []).map(
          (url) => rewrite(config, url, "pushinsteadof") ?? rewrite(config, url, "insteadof") ?? url,
        );
  return urls.length > 0 ? urls : null;
}
