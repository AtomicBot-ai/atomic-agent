/**
 * The hook folder git really uses, and the config files it includes,
 * so the sandbox keeps them read-only too (ATO-2471, review F1991.2).
 *
 * `.git/hooks` is protected by name, but a repo with `core.hooksPath`
 * set to a work-tree folder (husky's `.husky/_`, `.githooks`,
 * `tools/hooks`) runs its hooks from there, and a config `include.path`
 * or `includeIf.*.path` that names a file in the work tree lets that
 * file set `core.hooksPath` or `core.fsmonitor`. Both are read here from
 * the working folder's repo config and the global and system configs.
 * Only files are read; git is never run.
 */
import { lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** Every hook name git runs (githooks(5)). */
export const GIT_HOOK_NAMES: readonly string[] = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit",
  "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit",
  "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-receive",
  "update", "proc-receive", "post-receive", "post-update",
  "reference-transaction", "push-to-checkout", "pre-auto-gc",
  "post-rewrite", "sendemail-validate", "fsmonitor-watchman",
  "p4-changelist", "p4-prepare-changelist", "p4-post-changelist",
  "p4-pre-submit", "post-index-change",
];

export interface GitConfigEntry {
  /** Lower case; `includeif` for `[includeIf "..."]`. */
  section: string;
  /** Lower case. */
  key: string;
  value: string;
}

/** A config value: quotes dropped, escapes read, comment cut off. */
function readValue(raw: string): string {
  let out = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] as string;
    if (ch === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1] as string;
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (!quoted && (ch === "#" || ch === ";")) {
      break;
    } else {
      out += ch;
    }
  }
  return out.trim();
}

/** The `section`, `key` and `value` of each line of a git config file. */
export function parseGitConfig(text: string): GitConfigEntry[] {
  const out: GitConfigEntry[] = [];
  let section = "";
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line.startsWith("[")) {
      const end = line.indexOf("]");
      if (end < 0) continue;
      const header = line.slice(1, end).trim();
      section = (header.split(/[\s.]/)[0] ?? "").toLowerCase();
      // git takes a key on the same line as the header.
      line = line.slice(end + 1).trim();
    }
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    const key = (eq < 0 ? line : line.slice(0, eq)).trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(key)) continue;
    out.push({ section, key, value: eq < 0 ? "" : readValue(line.slice(eq + 1)) });
  }
  return out;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function expandHome(value: string, home: string): string {
  return value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
}

function lstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * The path a `.git` file names, or null. Read the way git reads it
 * (`read_gitfile_gently`, review F1991-R3 low): only trailing line ends
 * are cut, the file must start with `gitdir: `, and the rest is the path,
 * spaces and all (relative to the file's folder).
 */
export function readGitFile(file: string): string | null {
  const text = (readText(file) ?? "").replace(/[\r\n]+$/, "");
  if (!text.startsWith("gitdir: ") || text.length === 8) return null;
  return resolve(dirname(file), text.slice(8));
}

/** The repo of a folder: its top and its git folder, or null. */
export function findRepo(start: string): { top: string; gitDir: string } | null {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    const st = lstat(dotGit);
    if (st?.isDirectory() === true) return { top: dir, gitDir: dotGit };
    if (st?.isFile() === true) {
      const gitDir = readGitFile(dotGit);
      if (gitDir !== null) return { top: dir, gitDir };
    }
    if (dirname(dir) === dir) return null;
  }
}

/** The repo-level config files of a git folder (worktrees use the common one). */
function repoConfigFiles(gitDir: string): string[] {
  const common = readText(join(gitDir, "commondir"))?.replace(/[\r\n]+$/, "");
  const commonDir = common === undefined || common === "" ? gitDir : resolve(gitDir, common);
  return [join(commonDir, "config"), join(gitDir, "config.worktree")];
}

interface Found {
  hooksPaths: string[];
  includes: string[];
}

/** `core.hooksPath` values and included files, following includes. */
function scanConfig(file: string, home: string, found: Found, depth = 0): void {
  if (depth > 5) return;
  const text = readText(file);
  if (text === null) return;
  for (const { section, key, value } of parseGitConfig(text)) {
    if (value === "") continue;
    if (section === "core" && key === "hookspath") found.hooksPaths.push(expandHome(value, home));
    if ((section === "include" || section === "includeif") && key === "path") {
      const path = expandHome(value, home);
      const abs = isAbsolute(path) ? path : resolve(dirname(file), path);
      found.includes.push(abs);
      scanConfig(abs, home, found, depth + 1);
    }
  }
}

/** The real path of the longest part that exists, plus the rest. */
function realLoose(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realLoose(parent), basename(path));
  }
}

export interface GitHookTargetsInput {
  workRoots: readonly string[];
  home: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The hook folders and included config files to keep read-only, as
 * resolved paths. A relative `core.hooksPath` is taken from the top of
 * the work tree, as git does. When it names a working folder itself (or
 * a folder above one), only the hook files in it are listed, so the
 * whole folder does not turn read-only.
 */
export function gitHookTargets(input: GitHookTargetsInput): string[] {
  const env = input.env ?? process.env;
  const home = input.home;
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  const globalFile = env.GIT_CONFIG_GLOBAL?.trim();
  const globals = [
    ...(globalFile ? [globalFile] : [join(home, ".gitconfig"), join(xdg, "git/config")]),
    env.GIT_CONFIG_SYSTEM?.trim() || "/etc/gitconfig",
  ];
  const tops: string[] = [];
  const found: Found = { hooksPaths: [], includes: [] };
  const fromTop: string[] = [];
  for (const root of input.workRoots) {
    const repo = findRepo(root);
    if (repo === null) continue;
    tops.push(repo.top);
    const local: Found = { hooksPaths: [], includes: [] };
    for (const file of repoConfigFiles(repo.gitDir)) scanConfig(file, home, local);
    found.includes.push(...local.includes);
    found.hooksPaths.push(...local.hooksPaths.map((p) => (isAbsolute(p) ? p : resolve(repo.top, p))));
  }
  const global: Found = { hooksPaths: [], includes: [] };
  for (const file of globals) scanConfig(file, home, global);
  found.includes.push(...global.includes);
  for (const p of global.hooksPaths) {
    if (isAbsolute(p)) found.hooksPaths.push(p);
    else fromTop.push(p);
  }
  for (const p of fromTop) for (const top of tops) found.hooksPaths.push(resolve(top, p));
  const roots = input.workRoots.map(realLoose);
  const out: string[] = [];
  for (const dir of found.hooksPaths.map(realLoose)) {
    const holdsRoot = roots.some((r) => r === dir || r.startsWith(`${dir}/`));
    if (holdsRoot) out.push(...GIT_HOOK_NAMES.map((name) => join(dir, name)));
    else out.push(dir);
  }
  out.push(...found.includes.map(realLoose));
  return [...new Set(out)];
}
