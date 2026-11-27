import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startCommandJob } from "./command-job.js";
import { buildOsSandboxPolicy, buildSeatbeltProfile, findBwrap, wrapWithOsSandbox } from "./os-sandbox.js";
import {
  bwrapProtectedArgs,
  findProtectedPaths,
  SEATBELT_PROTECTED_PATTERNS,
} from "./sandbox-protected-paths.js";

/**
 * ATO-2471: git hooks and config, shell rc files, `.envrc` and editor
 * configs stay read-only even inside the working folder, because they
 * run code later outside the sandbox.
 */

const protectedOnMac = (path: string) =>
  SEATBELT_PROTECTED_PATTERNS.some((re) => new RegExp(re).test(path));

describe("Seatbelt protected-write patterns", () => {
  it("cover hooks, git config, rc files, .envrc and editor configs at any depth", () => {
    for (const path of [
      "/w/.git/hooks/pre-commit",
      "/w/.git/hooks",
      "/w/.git/config",
      "/w/.git",
      "/w/vendor/lib/.git/hooks/post-checkout",
      "/w/.git/modules/sub/hooks/pre-push",
      "/w/.git/modules/a/b/config",
      "/w/.zshrc",
      "/w/dotfiles/.bashrc",
      "/w/.profile",
      "/w/.envrc",
      "/w/.gitmodules",
      "/w/.config/fish/config.fish",
      "/w/.vscode/tasks.json",
      "/w/.vscode/settings.json",
      "/w/.vscode",
      "/w/.idea/workspace.xml",
    ]) {
      expect(protectedOnMac(path), path).toBe(true);
    }
  });

  it("leave ordinary project files and git's own data writable", () => {
    for (const path of [
      "/w/src/config",
      "/w/.git/objects/ab/cdef",
      "/w/.git/refs/heads/main",
      "/w/.git/index",
      "/w/.git/HEAD",
      "/w/.gitignore",
      "/w/.github/workflows/ci.yml",
      "/w/my.vscode.txt",
      "/w/.zshrc.bak",
      "/w/.ideas/notes.md",
    ]) {
      expect(protectedOnMac(path), path).toBe(false);
    }
  });

  it("deny after every rule that allows a write, reopened folders included", () => {
    const p = buildOsSandboxPolicy({
      workspaceRoots: ["/home/op/.atomic-agent/workspace"],
      stateDir: "/home/op/.atomic-agent",
      network: true,
      home: "/home/op",
      tmp: "/var/tmp-op",
    });
    const lines = buildSeatbeltProfile(p).split("\n");
    const deny = lines.findIndex((l) => l.startsWith("(deny file-write* (regex"));
    const lastAllow = Math.max(...lines.map((l, i) => (/^\(allow [^)]*file-write\*/.test(l) ? i : -1)));
    expect(deny).toBeGreaterThan(-1);
    expect(deny).toBeGreaterThan(lastAllow);
    expect(lines[deny]).toContain('(regex #"/\\.git/hooks(/.*)?$")');
  });
});

describe("findProtectedPaths and the bwrap binds (Linux)", () => {
  let root = "";
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-sbx-2471-")));
    for (const dir of [
      ".git/hooks",
      ".git/objects",
      ".git/modules/sub/hooks",
      ".vscode",
      ".config/fish",
      "pkg/inner/.git",
      "node_modules/dep/.git/hooks",
      "a/b/c/d/.vscode",
      "src",
    ]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    for (const file of [".git/config", ".zshrc", ".envrc", "src/index.ts", ".git/modules/sub/config"]) {
      writeFileSync(join(root, file), "");
    }
    mkdirSync(join(root, "wt"));
    writeFileSync(join(root, "wt/.git"), "gitdir: /elsewhere\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("lists the protected paths that exist, and nothing else", () => {
    const found = findProtectedPaths([root]);
    const at = (p: string) => join(root, p);
    expect(found).toEqual(
      expect.arrayContaining([
        at(".git/hooks"),
        at(".git/config"),
        at(".git/modules/sub/hooks"),
        at(".git/modules/sub/config"),
        at(".vscode"),
        at(".zshrc"),
        at(".envrc"),
        at(".config/fish"),
        // A `.git` with no hooks folder is protected whole.
        at("pkg/inner/.git"),
        // A `.git` file would point git at a folder of the command's choosing.
        at("wt/.git"),
      ]),
    );
    expect(found).not.toContain(at(".git/objects"));
    expect(found).not.toContain(at(".git"));
    expect(found).not.toContain(at("src"));
    expect(found.some((p) => p.includes("node_modules"))).toBe(false);
    // Deeper than three levels below the root: not searched.
    expect(found).not.toContain(at("a/b/c/d/.vscode"));
  });

  it("binds them read-only after the working folder is bound writable", () => {
    const p = buildOsSandboxPolicy({ workspaceRoots: [root], network: true, home: "/home/op", tmp: "/var/tmp-op" });
    const w = wrapWithOsSandbox("ls", [], p, { platform: "linux", bwrap: "/usr/bin/bwrap" });
    if (!w.ok) throw new Error(w.reason);
    const hooks = join(root, ".git/hooks");
    const bindRoot = w.args.findIndex((a, i) => a === "--bind" && w.args[i + 1] === root);
    const roHooks = w.args.findIndex((a, i) => a === "--ro-bind" && w.args[i + 1] === hooks);
    expect(bindRoot).toBeGreaterThan(-1);
    expect(roHooks).toBeGreaterThan(bindRoot);
    expect(w.args[roHooks + 2]).toBe(hooks);
    expect(roHooks).toBeLessThan(w.args.indexOf("--"));
  });

  it("makes the folders above each protected path mount points, so they cannot be renamed away", () => {
    const hooks = join(root, ".git/hooks");
    const inner = join(root, "pkg/inner/.git");
    const args = bwrapProtectedArgs([hooks, inner], [root], [], []);
    const bindOf = (dir: string) => args.findIndex((a, i) => a === "--bind" && args[i + 1] === dir);
    const roOf = (dir: string) => args.findIndex((a, i) => a === "--ro-bind" && args[i + 1] === dir);
    expect(bindOf(join(root, ".git"))).toBeGreaterThan(-1);
    expect(bindOf(join(root, "pkg"))).toBeLessThan(bindOf(join(root, "pkg/inner")));
    expect(bindOf(join(root, "pkg/inner"))).toBeLessThan(roOf(inner));
    expect(bindOf(join(root, ".git"))).toBeLessThan(roOf(hooks));
    // The working folder itself is already a mount point.
    expect(bindOf(root)).toBe(-1);
  });

  it("skips a path inside a hidden folder unless that part is opened again", () => {
    const rc = join(root, ".zshrc");
    expect(bwrapProtectedArgs([rc], [root], [root], [])).toEqual([]);
    expect(bwrapProtectedArgs([rc], [root], [root], [root])).toEqual(["--ro-bind", rc, rc]);
    expect(bwrapProtectedArgs([join(root, "missing")], [root], [], [])).toEqual([]);
  });
});

// The bypass on the real sandbox: a hook planted in the working folder.
async function plant(work: string, script: string, bwrap?: string): Promise<void> {
  mkdirSync(join(work, ".git/hooks"), { recursive: true });
  writeFileSync(join(work, ".git/config"), "[core]\n");
  // Network on: the protection does not depend on it, and the spawn
  // then needs nothing beyond the wrapped command line.
  const p = buildOsSandboxPolicy({ workspaceRoots: [work], network: true });
  const w = wrapWithOsSandbox("/bin/sh", ["-c", script], p, bwrap === undefined ? {} : { bwrap });
  if (!w.ok) throw new Error(w.reason);
  const job = startCommandJob(w.command, w.args, { cwd: work });
  expect(await job.waitFor(20_000)).toBe("exited");
}

const ATTACK = [
  "echo x > .git/hooks/pre-commit",
  "echo '[core] hooksPath = /tmp/evil' >> .git/config",
  "ln -s .git/hooks h && echo x > h/post-checkout",
  "mv .git old-git",
  "echo ok > src.txt",
];

function expectNoHook(work: string): void {
  expect(existsSync(join(work, "src.txt"))).toBe(true);
  expect(existsSync(join(work, ".git/hooks/pre-commit"))).toBe(false);
  expect(existsSync(join(work, ".git/hooks/post-checkout"))).toBe(false);
  expect(existsSync(join(work, "old-git"))).toBe(false);
  expect(readFileSync(join(work, ".git/config"), "utf8")).toBe("[core]\n");
}

const realSeatbelt = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
describe.skipIf(!realSeatbelt)("a sandboxed command cannot plant a git hook (macOS, ATO-2471)", () => {
  let work = "";
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it("refuses the hook, the config, a link into hooks, a renamed .git and a new .vscode", async () => {
    work = realpathSync(mkdtempSync(join(tmpdir(), "atomic-sbx-2471-run-")));
    await plant(work, [...ATTACK, "mkdir -p .vscode", "mkdir -p sub/.git/hooks"].join("; "));
    expectNoHook(work);
    expect(existsSync(join(work, ".vscode"))).toBe(false);
    expect(existsSync(join(work, "sub/.git"))).toBe(false);
  });
});

const realBwrap = process.platform === "linux" ? findBwrap() : null;
describe.skipIf(realBwrap === null)("a sandboxed command cannot plant a git hook (Linux, ATO-2471)", () => {
  let work = "";
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it("refuses the hook, the config, a link into hooks and a renamed .git", async () => {
    work = realpathSync(mkdtempSync(join(tmpdir(), "atomic-sbx-2471-run-")));
    await plant(work, ATTACK.join("; "), realBwrap ?? undefined);
    expectNoHook(work);
  });
});
