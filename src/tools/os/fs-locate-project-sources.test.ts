import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeCtx,
  makeTool,
  session,
  trySymlink,
} from "./fs-locate-project-test-helpers.js";

/** Candidate collection: cwd chain, session history, configured roots. */
describe("os.fs.locate_project sources", () => {
  let base: string;

  beforeEach(async () => {
    // realpath so expectations survive symlinked tmp dirs
    // (macOS /var -> /private/var) now that candidates are canonicalized.
    base = await realpath(await mkdtemp(join(tmpdir(), "locate-src-")));
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

  it("matches the configured root itself by name", async () => {
    const root = join(base, "tasks-board");
    await mkdir(root, { recursive: true });

    const tool = makeTool({ projectRoots: [root] });
    const res = await tool.run({ name: "tasks-board" }, makeCtx(base));

    expect(res.details?.found).toBe(true);
    expect(res.details?.path).toBe(root);
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

  it("scans configured roots one level deep only", async () => {
    const root = join(base, "dev");
    await mkdir(join(root, "group", "nested-project"), { recursive: true });

    const tool = makeTool({ projectRoots: [root] });
    const res = await tool.run({ name: "nested-project" }, makeCtx(base));

    expect(res.details?.found).toBe(false);
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
    await mkdir(join(root, "Café-proj"), { recursive: true });

    const tool = makeTool({ projectRoots: [root] });
    const res = await tool.run({ name: "café-proj" }, makeCtx(base));

    expect(res.details?.found).toBe(true);
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
});
