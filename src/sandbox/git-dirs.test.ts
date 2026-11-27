import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startCommandJob } from "./command-job.js";
import { findGitDirs, gitDataDirs, looksLikeGitDir } from "./git-dirs.js";
import { buildOsSandboxPolicy, buildSeatbeltProfile, findBwrap, wrapWithOsSandbox } from "./os-sandbox.js";
import { SEATBELT_GIT_STATE_FILE_PATTERN } from "./sandbox-protected-paths.js";

/**
 * ATO-2471, review R2-1991.A: a git folder not named `.git` (a bare
 * `.bare` with a `.git` file saying `gitdir: ./.bare`, or
 * `--separate-git-dir` inside the working folder) keeps its hooks and
 * config read-only like a `.git`.
 */

/** A bare repo's shape, without running git. */
function bare(dir: string): void {
  for (const sub of ["objects", "refs/heads", "hooks"]) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, "config"), "[core]\n\tbare = true\n");
}

describe("findGitDirs", () => {
  let root = "";
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-sbx-gitdirs-")));
    // The worktree layout: `.bare` plus a `.git` file, and a linked worktree.
    bare(join(root, ".bare"));
    writeFileSync(join(root, ".git"), "gitdir: ./.bare\n");
    mkdirSync(join(root, ".bare/worktrees/main"), { recursive: true });
    writeFileSync(join(root, ".bare/worktrees/main/HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(root, ".bare/worktrees/main/commondir"), "../..\n");
    mkdirSync(join(root, "main"));
    writeFileSync(join(root, "main/.git"), `gitdir: ${join(root, ".bare/worktrees/main")}\n`);
    // `--separate-git-dir sep` for `other`.
    bare(join(root, "sep"));
    mkdirSync(join(root, "other"));
    writeFileSync(join(root, "other/.git"), "gitdir: ../sep\n");
    // A bare repo found by its shape alone, and one under node_modules.
    bare(join(root, "vendor/lib.git"));
    bare(join(root, "node_modules/dep.git"));
    mkdirSync(join(root, "src"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("finds a .git file's gitdir, its commondir and bare repos by shape", () => {
    const found = findGitDirs([root]);
    const at = (p: string) => join(root, p);
    expect(found).toEqual(
      expect.arrayContaining([at(".bare"), at(".bare/worktrees/main"), at("sep"), at("vendor/lib.git")]),
    );
    expect(found).not.toContain(at("src"));
    expect(found.some((p) => p.includes("node_modules"))).toBe(false);
    expect(looksLikeGitDir(at("src"))).toBe(false);
  });

  it("finds the git folder of a working folder below the repo top", () => {
    expect(findGitDirs([join(root, "main")])).toEqual(
      expect.arrayContaining([join(root, ".bare/worktrees/main"), join(root, ".bare")]),
    );
  });

  it("lists the data folders of the git folder and of its worktrees", () => {
    const data = gitDataDirs(join(root, ".bare"));
    expect(data).toEqual(
      expect.arrayContaining([join(root, ".bare/objects"), join(root, ".bare/refs"), join(root, ".bare/worktrees/main/logs")]),
    );
    expect(data.some((p) => p.endsWith("/hooks") || p.endsWith("/config"))).toBe(false);
  });

  it("puts them into the policy, the Seatbelt rule and the bwrap binds", () => {
    const p = buildOsSandboxPolicy({ workspaceRoots: [root], network: true, home: "/home/op", tmp: "/var/tmp-op" });
    expect(p.gitDirs?.map((g) => g.dir)).toEqual(expect.arrayContaining([join(root, ".bare"), join(root, "sep")]));
    const mac = wrapWithOsSandbox("ls", [], p, { platform: "darwin", seatbeltAvailable: true });
    if (!mac.ok) throw new Error(mac.reason);
    const name = mac.args.find((a) => a.endsWith(`=${join(root, ".bare")}`))?.split("=")[0] ?? "";
    expect(name).toMatch(/^G[0-9]+$/);
    expect(buildSeatbeltProfile(p)).toContain(`(deny file-write* (require-all (subpath (param "${name}"))`);
    const linux = wrapWithOsSandbox("ls", [], p, { platform: "linux", bwrap: "/usr/bin/bwrap" });
    if (!linux.ok) throw new Error(linux.reason);
    const bindRoot = linux.args.findIndex((a, i) => a === "--bind" && linux.args[i + 1] === root);
    const roBare = linux.args.findIndex((a, i) => a === "--ro-bind" && linux.args[i + 1] === join(root, ".bare"));
    expect(roBare).toBeGreaterThan(bindRoot);
    expect(linux.args.findIndex((a, i) => a === "--ro-bind" && linux.args[i + 1] === join(root, "sep"))).toBeGreaterThan(-1);
  });

  it("the macOS rule keeps hooks, config, commondir and new worktrees read-only, data writable", () => {
    const g = buildOsSandboxPolicy({ workspaceRoots: [root], network: true }).gitDirs?.find(
      (e) => e.dir === join(root, ".bare"),
    );
    if (g === undefined) throw new Error("no .bare");
    const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);
    const denied = (rel: string) => {
      const path = join(root, rel);
      return (
        inside(path, g.dir) &&
        !(new RegExp(SEATBELT_GIT_STATE_FILE_PATTERN).test(path) || g.data.some((d) => inside(path, d)))
      );
    };
    for (const rel of [
      ".bare",
      ".bare/hooks/pre-commit",
      ".bare/config",
      ".bare/config.worktree",
      ".bare/info/attributes",
      ".bare/commondir",
      ".bare/worktrees/main/commondir",
      ".bare/worktrees/main/gitdir",
      ".bare/worktrees/evil",
      ".bare/modules/new",
      ".bare/rebase-merge/git-rebase-todo",
    ]) {
      expect(denied(rel), rel).toBe(true);
    }
    for (const rel of [
      ".bare/objects/ab/cd",
      ".bare/refs/heads/main",
      ".bare/HEAD",
      ".bare/index.lock",
      ".bare/worktrees/main/index",
      ".bare/worktrees/main/HEAD",
      ".bare/worktrees/main/logs/HEAD",
    ]) {
      expect(denied(rel), rel).toBe(false);
    }
  });
});

// The bypass on the real sandbox: the review's layout, built with git.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", env: gitEnv });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const hasGit = spawnSync("git", ["--version"]).status === 0;

function layout(base: string): string {
  const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
  git(base, "init", "-q", "src");
  git(join(base, "src"), ...id, "commit", "-q", "--allow-empty", "-m", "init");
  git(base, "clone", "-q", "--bare", "src", "proj/.bare");
  const proj = join(base, "proj");
  writeFileSync(join(proj, ".git"), "gitdir: ./.bare\n");
  git(proj, "worktree", "add", "-q", "main");
  git(proj, "init", "-q", `--separate-git-dir=${join(proj, "sep")}`, "other");
  return proj;
}

async function runIn(work: string, cwd: string, script: string, bwrap?: string): Promise<void> {
  const p = buildOsSandboxPolicy({ workspaceRoots: [work], network: true });
  const env = "export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1; ";
  const w = wrapWithOsSandbox("/bin/sh", ["-c", env + script], p, bwrap === undefined ? {} : { bwrap });
  if (!w.ok) throw new Error(w.reason);
  const job = startCommandJob(w.command, w.args, { cwd });
  expect(await job.waitFor(30_000)).toBe("exited");
}

const ATTACK = [
  "echo x > .bare/hooks/pre-commit",
  "echo '[core] hooksPath = /tmp/evil' >> .bare/config",
  "echo x > sep/hooks/pre-commit",
  "echo ../../evil > .bare/worktrees/main/commondir",
  // The `.git` file cannot be pointed elsewhere.
  "printf 'gitdir: /tmp/evil\\n' > .git",
  "printf 'gitdir: /tmp/evil\\n' > main/.git",
  "mv .bare old-bare",
  "echo ok > note.txt",
].join("; ");

function expectNoHook(proj: string, config: string): void {
  expect(existsSync(join(proj, "note.txt"))).toBe(true);
  expect(existsSync(join(proj, ".bare/hooks/pre-commit"))).toBe(false);
  expect(existsSync(join(proj, "sep/hooks/pre-commit"))).toBe(false);
  expect(readFileSync(join(proj, ".bare/config"), "utf8")).toBe(config);
  expect(readFileSync(join(proj, ".bare/worktrees/main/commondir"), "utf8")).not.toContain("evil");
  expect(readFileSync(join(proj, ".git"), "utf8")).toBe("gitdir: ./.bare\n");
  expect(readFileSync(join(proj, "main/.git"), "utf8")).not.toContain("evil");
  expect(existsSync(join(proj, "old-bare"))).toBe(false);
}

const realSeatbelt = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") && hasGit;
describe.skipIf(!realSeatbelt)("a bare or separate git folder on the real sandbox (macOS)", () => {
  let base = "";
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "atomic-sbx-bare-")));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("refuses its hook, config and commondir and the .git file, and git still commits", async () => {
    const proj = layout(base);
    const config = readFileSync(join(proj, ".bare/config"), "utf8");
    const id = "-c user.name=t -c user.email=t@t";
    const commits = [
      `cd main && echo a > a && git add a && git ${id} commit -qm a && cd ..`,
      `cd other && echo b > b && git add b && git ${id} commit -qm b && cd ..`,
    ];
    await runIn(proj, proj, `${ATTACK}; ${commits.join("; ")}`);
    expectNoHook(proj, config);
    expect(git(join(proj, "main"), "log", "--format=%s", "-1").trim()).toBe("a");
    expect(git(join(proj, "other"), "log", "--format=%s", "-1").trim()).toBe("b");
  });

  it("lets ordinary git add and commit work in a plain repo, but not a rebase todo (R2-1991.B)", async () => {
    git(base, "init", "-q", "r");
    const repo = join(base, "r");
    const id = "-c user.name=t -c user.email=t@t";
    await runIn(
      repo,
      repo,
      [
        `echo a > a && git add a && git ${id} commit -qm a`,
        `git checkout -qb b && echo b > b && git add b && git ${id} commit -qm b && git checkout -q main`,
        "mkdir -p .git/rebase-merge && printf 'exec touch /tmp/evil\\n' > .git/rebase-merge/git-rebase-todo",
        "mkdir -p .git/rebase-apply && echo x > .git/rebase-apply/patch",
      ].join("; "),
    );
    expect(git(repo, "log", "--format=%s", "b").split("\n").filter(Boolean)).toEqual(["b", "a"]);
    expect(existsSync(join(repo, ".git/rebase-merge"))).toBe(false);
    expect(existsSync(join(repo, ".git/rebase-apply"))).toBe(false);
  });
});

const realBwrap = process.platform === "linux" && hasGit ? findBwrap() : null;
describe.skipIf(realBwrap === null)("a bare or separate git folder on the real sandbox (Linux)", () => {
  let base = "";
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("refuses its hook, config and commondir and the .git file", async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "atomic-sbx-bare-")));
    const proj = layout(base);
    const config = readFileSync(join(proj, ".bare/config"), "utf8");
    await runIn(proj, proj, ATTACK, realBwrap ?? undefined);
    expectNoHook(proj, config);
  });
});
