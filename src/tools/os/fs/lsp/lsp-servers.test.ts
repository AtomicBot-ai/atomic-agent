import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findGitRoot, findOnPath, serverForPath } from "./lsp-servers.js";

describe("serverForPath (ATO-503)", () => {
  it("maps TypeScript/JavaScript and Python files, nothing else", () => {
    expect(serverForPath("/r/a.ts")?.id).toBe("typescript");
    expect(serverForPath("/r/A.TSX")?.languageId("/r/A.TSX")).toBe("typescriptreact");
    expect(serverForPath("/r/a.mjs")?.languageId("/r/a.mjs")).toBe("javascript");
    expect(serverForPath("/r/a.py")?.id).toBe("pyright");
    expect(serverForPath("/r/a.go")).toBeNull();
    expect(serverForPath("/r/README.md")).toBeNull();
  });
});

describe("findOnPath / findGitRoot (ATO-503)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-lsp-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "finds an executable on PATH and skips a non-executable one",
    async () => {
      const a = join(dir, "a");
      const b = join(dir, "b");
      await mkdir(a);
      await mkdir(b);
      await writeFile(join(a, "pyright-langserver"), "#!/bin/sh\n");
      await writeFile(join(b, "pyright-langserver"), "#!/bin/sh\n");
      await chmod(join(b, "pyright-langserver"), 0o755);
      const env = { PATH: [join(dir, "missing"), a, b].join(":") };
      expect(findOnPath("pyright-langserver", env, "darwin")).toBe(join(b, "pyright-langserver"));
      expect(findOnPath("typescript-language-server", env, "darwin")).toBeNull();
    },
  );

  it("tries the PATHEXT shims on Windows", async () => {
    await writeFile(join(dir, "typescript-language-server.cmd"), "@echo off\r\n");
    const env = { PATH: dir, PATHEXT: ".EXE;.CMD" };
    expect(findOnPath("typescript-language-server", env, "win32")).toBe(
      join(dir, "typescript-language-server.cmd"),
    );
  });

  it("finds the nearest work tree, a worktree's .git file included", async () => {
    const repo = join(dir, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, "src", "deep"), { recursive: true });
    expect(findGitRoot(join(repo, "src", "deep"), "/nowhere")).toBe(repo);

    const worktree = join(dir, "wt");
    await mkdir(join(worktree, "lib"), { recursive: true });
    await writeFile(join(worktree, ".git"), "gitdir: /elsewhere\n");
    expect(findGitRoot(join(worktree, "lib"), "/nowhere")).toBe(worktree);
  });

  it("does not count a folder outside any repository, or a repository at home", async () => {
    await mkdir(join(dir, "loose"));
    expect(findGitRoot(join(dir, "loose"), "/nowhere")).toBeNull();

    await mkdir(join(dir, ".git"));
    await mkdir(join(dir, "Downloads"));
    expect(findGitRoot(join(dir, "Downloads"), dir)).toBeNull();
  });
});
