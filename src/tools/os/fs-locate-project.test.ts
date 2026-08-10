import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tool-registry.js";
import { resourceClassFor } from "../../agent/tool-resource-class.js";
import { isRareToolName } from "../../prompt/tool-descriptors.js";
import {
  buildOsFsLocateProjectTool,
  type OsFsLocateProjectDeps,
} from "./fs-locate-project.js";
import type { RecentSessionDir } from "./fs-locate-project-sources.js";

/** Windows without Developer Mode cannot create symlinks; skip there. */
async function trySymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, "dir");
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return false;
    throw err;
  }
}

function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
    sessionId: "test-session",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

function makeTool(overrides: Partial<OsFsLocateProjectDeps> = {}) {
  return buildOsFsLocateProjectTool({
    listRecentSessions: () => [],
    projectRoots: [],
    ...overrides,
  });
}

function session(workingDir: string, updatedAt = 1): RecentSessionDir {
  return { workingDir, updatedAt };
}

describe("os.fs.locate_project", () => {
  let base: string;

  beforeEach(async () => {
    // realpath so expectations survive symlinked tmp dirs
    // (macOS /var -> /private/var) now that candidates are canonicalized.
    base = await realpath(await mkdtemp(join(tmpdir(), "locate-project-")));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("finds a project among the direct children of a configured root", async () => {
    const root = join(base, "dev");
    const project = join(root, "tasks-board");
    await mkdir(project, { recursive: true });
    await mkdir(join(root, "unrelated"), { recursive: true });

    const tool = makeTool({ projectRoots: [root] });
    const res = await tool.run({ name: "tasks-board" }, makeCtx(base));

    expect(res.status).toBe("ok");
    expect(res.details?.found).toBe(true);
    expect(res.details?.path).toBe(project);
    expect(res.details?.source).toBe("configured-root");
    expect(res.summary).toContain(project);
  });

  it("finds a project via a recent session working dir", async () => {
    const project = join(base, "raylib");
    await mkdir(project, { recursive: true });

    const tool = makeTool({
      listRecentSessions: () => [session(project, 42)],
    });
    const res = await tool.run({ name: "raylib" }, makeCtx(base));

    expect(res.details?.found).toBe(true);
    expect(res.details?.path).toBe(project);
    expect(res.details?.source).toBe("session-history");
  });

  it("finds a project via the session cwd ancestry", async () => {
    const project = join(base, "my-app");
    const nested = join(project, "src", "deep");
    await mkdir(nested, { recursive: true });

    const tool = makeTool();
    const res = await tool.run({ name: "my-app" }, makeCtx(nested));

    expect(res.details?.found).toBe(true);
    expect(res.details?.path).toBe(project);
    expect(res.details?.source).toBe("cwd");
  });

  it("reports ambiguity instead of guessing when two dirs match equally", async () => {
    const rootA = join(base, "root-a");
    const rootB = join(base, "root-b");
    await mkdir(join(rootA, "api"), { recursive: true });
    await mkdir(join(rootB, "api"), { recursive: true });

    const tool = makeTool({ projectRoots: [rootA, rootB] });
    const res = await tool.run({ name: "api" }, makeCtx(base));

    expect(res.status).toBe("ok");
    expect(res.details?.found).toBe(false);
    expect(res.details?.ambiguous).toBe(true);
    expect(res.details?.path).toBeUndefined();
    expect(res.summary).toContain("ambiguous");
    expect(res.summary).toContain("do not guess");
    const candidates = res.details?.candidates as Array<{ path: string }>;
    expect(candidates.map((c) => c.path).sort()).toEqual([
      join(rootA, "api"),
      join(rootB, "api"),
    ]);
  });

  it("is honest on a miss and points at projects.roots", async () => {
    const tool = makeTool();
    const res = await tool.run({ name: "does-not-exist" }, makeCtx(base));

    expect(res.status).toBe("ok");
    expect(res.details?.found).toBe(false);
    expect(res.details?.ambiguous).toBe(false);
    expect(res.summary).toContain("no project directory matching");
    expect(res.summary).toContain("Ask the user for the full path");
    expect(res.summary).toContain("projects.roots");
  });

  it("never matches hidden dirs, node_modules, or __pycache__ under a root", async () => {
    const root = join(base, "dev");
    await mkdir(join(root, ".config-app"), { recursive: true });
    await mkdir(join(root, "node_modules"), { recursive: true });
    await mkdir(join(root, "__pycache__"), { recursive: true });

    const tool = makeTool({ projectRoots: [root] });
    const hidden = await tool.run({ name: "config-app" }, makeCtx(base));
    expect(hidden.details?.found).toBe(false);

    const nm = await tool.run({ name: "node_modules" }, makeCtx(base));
    expect(nm.details?.found).toBe(false);

    const pycache = await tool.run({ name: "__pycache__" }, makeCtx(base));
    expect(pycache.details?.found).toBe(false);
  });

  it("does not follow symlinked dirs under a root", async () => {
    const root = join(base, "dev");
    const outside = join(base, "outside", "linked-project");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    if (!(await trySymlink(outside, join(root, "linked-project")))) return;

    const tool = makeTool({ projectRoots: [root] });
    const res = await tool.run({ name: "linked-project" }, makeCtx(base));

    expect(res.details?.found).toBe(false);
  });

  it("scans configured roots one level deep only", async () => {
    const root = join(base, "dev");
    await mkdir(join(root, "group", "nested-project"), { recursive: true });

    const tool = makeTool({ projectRoots: [root] });
    const res = await tool.run({ name: "nested-project" }, makeCtx(base));

    expect(res.details?.found).toBe(false);
  });

  it("matches the configured root itself by name", async () => {
    const root = join(base, "tasks-board");
    await mkdir(root, { recursive: true });

    const tool = makeTool({ projectRoots: [root] });
    const res = await tool.run({ name: "tasks-board" }, makeCtx(base));

    expect(res.details?.found).toBe(true);
    expect(res.details?.path).toBe(root);
  });

  it("drops recent-session dirs that no longer exist", async () => {
    const gone = join(base, "deleted-project");

    const tool = makeTool({
      listRecentSessions: () => [session(gone, 42)],
    });
    const res = await tool.run({ name: "deleted-project" }, makeCtx(base));

    expect(res.details?.found).toBe(false);
  });

  it("skips missing and non-absolute roots without failing", async () => {
    const root = join(base, "dev");
    const project = join(root, "site");
    await mkdir(project, { recursive: true });

    const tool = makeTool({
      projectRoots: ["relative/root", join(base, "missing-root"), root],
    });
    const res = await tool.run({ name: "site" }, makeCtx(base));

    expect(res.details?.found).toBe(true);
    expect(res.details?.path).toBe(project);
    expect(res.details?.invalidRoots).toEqual(["relative/root"]);
    expect(res.details?.unreadableRoots).toEqual([join(base, "missing-root")]);
    expect(res.details?.rootsScanned).toBe(1);
  });

  it("prefers an exact basename match over substring matches", async () => {
    const root = join(base, "dev");
    await mkdir(join(root, "raylib"), { recursive: true });
    await mkdir(join(root, "_raylib"), { recursive: true });

    const tool = makeTool({ projectRoots: [root] });
    const res = await tool.run({ name: "raylib" }, makeCtx(base));

    expect(res.details?.found).toBe(true);
    expect(res.details?.path).toBe(join(root, "raylib"));
    const candidates = res.details?.candidates as Array<{ path: string }>;
    expect(candidates.map((c) => c.path)).toContain(join(root, "_raylib"));
  });

  it("resolves the issue example: substring match on a pasted fragment", async () => {
    const root = join(base, "drive-e");
    const project = join(root, "_raylib");
    await mkdir(project, { recursive: true });

    const tool = makeTool({ projectRoots: [root] });
    const res = await tool.run({ name: "raylib" }, makeCtx(base));

    expect(res.details?.found).toBe(true);
    expect(res.details?.path).toBe(project);
  });

  it("dedupes the same dir reported by several sources", async () => {
    const root = join(base, "dev");
    const project = join(root, "shop");
    await mkdir(project, { recursive: true });

    const tool = makeTool({
      projectRoots: [root],
      listRecentSessions: () => [session(project, 42)],
    });
    const res = await tool.run({ name: "shop" }, makeCtx(base));

    expect(res.details?.found).toBe(true);
    expect(res.details?.path).toBe(project);
    const candidates = res.details?.candidates as Array<{ path: string }>;
    expect(candidates).toHaveLength(1);
    expect(res.details?.source).toBe("session-history");
  });

  it("prefers the more recent session dir when two sessions tie on tier", async () => {
    const older = join(base, "a", "blog");
    const newer = join(base, "b", "blog");
    await mkdir(older, { recursive: true });
    await mkdir(newer, { recursive: true });

    const tool = makeTool({
      listRecentSessions: () => [session(older, 10), session(newer, 20)],
    });
    const res = await tool.run({ name: "blog" }, makeCtx(base));

    // Two exact matches stay ambiguous, but ordering puts the newer first.
    expect(res.details?.ambiguous).toBe(true);
    const candidates = res.details?.candidates as Array<{ path: string }>;
    expect(candidates[0]?.path).toBe(newer);
  });

  it("clamps limit and caps the candidate list", async () => {
    const root = join(base, "dev");
    for (let i = 0; i < 6; i++) {
      await mkdir(join(root, `svc-${i}`), { recursive: true });
    }

    const tool = makeTool({ projectRoots: [root] });
    const res = await tool.run({ name: "svc", limit: 3 }, makeCtx(base));

    const candidates = res.details?.candidates as Array<{ path: string }>;
    expect(candidates).toHaveLength(3);
  });

  it("keeps reporting ambiguity even when limit clamps the displayed list", async () => {
    const rootA = join(base, "root-a");
    const rootB = join(base, "root-b");
    await mkdir(join(rootA, "api"), { recursive: true });
    await mkdir(join(rootB, "api"), { recursive: true });

    const tool = makeTool({ projectRoots: [rootA, rootB] });
    const res = await tool.run({ name: "api", limit: 1 }, makeCtx(base));

    expect(res.details?.ambiguous).toBe(true);
    expect(res.details?.found).toBe(false);
    const candidates = res.details?.candidates as Array<{ path: string }>;
    expect(candidates).toHaveLength(1);
    expect(res.summary).toContain("1 more");
  });

  it("throws on a missing name argument", async () => {
    const tool = makeTool();
    await expect(tool.run({}, makeCtx(base))).rejects.toThrow(
      "`name` must be a non-empty string",
    );
  });

  it("fast-path: returns a pasted absolute directory path immediately", async () => {
    const pasted = join(base, "pasted-project");
    await mkdir(pasted, { recursive: true });

    const tool = makeTool();
    const res = await tool.run({ name: pasted }, makeCtx(base));

    expect(res.details?.found).toBe(true);
    expect(res.details?.path).toBe(pasted);
    expect(res.details?.source).toBe("direct-path");
    expect(res.summary).toContain(pasted);
    expect(res.summary).not.toContain("Ask the user for the full path");
  });

  it("fast-path: a missing absolute path falls through to the honest miss", async () => {
    const tool = makeTool();
    const res = await tool.run(
      { name: join(base, "ghost-project") },
      makeCtx(base),
    );

    expect(res.details?.found).toBe(false);
    expect(res.summary).toContain("no project directory matching");
  });

  it("normalizes backslash input to match by the last segment", async () => {
    const root = join(base, "dev");
    await mkdir(join(root, "_raylib"), { recursive: true });

    const tool = makeTool({ projectRoots: [root] });
    const res = await tool.run({ name: "e:\\dev\\_raylib" }, makeCtx(base));

    expect(res.details?.found).toBe(true);
    expect(res.details?.path).toBe(join(root, "_raylib"));
  });

  it("miss with all roots unreadable names the problem in the summary", async () => {
    const tool = makeTool({
      projectRoots: [join(base, "nope-a"), join(base, "nope-b")],
    });
    const res = await tool.run({ name: "anything" }, makeCtx(base));

    expect(res.details?.found).toBe(false);
    expect(res.summary).toContain(
      "none of the 2 configured projects.roots could be scanned",
    );
    expect(res.summary).toContain("2 configured root(s) could not be read");
    expect(res.summary).not.toContain("and 2 configured root(s)");
  });

  it("reports whitespace-only roots as invalid in the summary", async () => {
    const tool = makeTool({ projectRoots: ["   "] });
    const res = await tool.run({ name: "anything" }, makeCtx(base));

    expect(res.details?.found).toBe(false);
    expect(res.details?.invalidRoots).toEqual(["   "]);
    expect(res.details?.rootsScanned).toBe(0);
    expect(res.summary).toContain("skipped (empty or not absolute)");
  });

  it("surfaces a truncation note in the summary when a root exceeds the cap", async () => {
    const root = join(base, "huge");
    await mkdir(root, { recursive: true });
    for (let i = 0; i < 501; i++) {
      await mkdir(join(root, `p${String(i).padStart(3, "0")}`));
    }

    const tool = makeTool({ projectRoots: [root] });
    const res = await tool.run({ name: "zzz-no-match" }, makeCtx(base));

    expect(res.details?.found).toBe(false);
    expect(res.summary).toContain("truncated at 500 entries");
    expect(res.details?.truncatedRoots).toEqual([root]);
  });

  it("loose files do not consume the per-root cap", async () => {
    const root = join(base, "files-heavy");
    await mkdir(root, { recursive: true });
    for (let i = 0; i < 600; i++) {
      await writeFile(join(root, `aaa-file-${String(i).padStart(3, "0")}.txt`), "");
    }
    await mkdir(join(root, "zzz-needle"));

    const tool = makeTool({ projectRoots: [root] });
    const res = await tool.run({ name: "zzz-needle" }, makeCtx(base));

    expect(res.details?.found).toBe(true);
    expect(res.details?.path).toBe(join(root, "zzz-needle"));
    expect(res.details?.truncatedRoots).toBeUndefined();
  });

  it("collapses symlink aliases of the same dir instead of reporting ambiguity", async () => {
    const root = join(base, "dev");
    const project = join(root, "app");
    await mkdir(project, { recursive: true });
    if (!(await trySymlink(root, join(base, "link-dev")))) return;

    const tool = makeTool({
      projectRoots: [root],
      listRecentSessions: () => [session(join(base, "link-dev", "app"), 42)],
    });
    const res = await tool.run({ name: "app" }, makeCtx(base));

    expect(res.details?.ambiguous).toBe(false);
    expect(res.details?.found).toBe(true);
    expect(res.details?.path).toBe(project);
    const candidates = res.details?.candidates as Array<{ path: string }>;
    expect(candidates).toHaveLength(1);
  });

  it("matches across unicode normalization forms (NFC query, NFD dir)", async () => {
    const root = join(base, "dev");
    // "Café-proj" with a combining acute accent (NFD).
    await mkdir(join(root, "Cafe\u0301-proj"), { recursive: true });

    const tool = makeTool({ projectRoots: [root] });
    const res = await tool.run({ name: "caf\u00e9-proj" }, makeCtx(base));

    expect(res.details?.found).toBe(true);
  });

  it("is pinned pure_read and frequent-tier", () => {
    expect(resourceClassFor("os.fs.locate_project")).toBe("pure_read");
    expect(isRareToolName("os.fs.locate_project")).toBe(false);
  });
});
