import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  candidateName,
  DEFAULT_CANDIDATE_LIMITS,
  defaultCandidateRoots,
  findPathCandidates,
} from "./path-candidates.js";

describe("findPathCandidates", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "atomic-path-candidates-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const roots = () => defaultCandidateRoots(join(home, "Desktop", "Atomic Agent"), home);

  // ATO-413: the model looked inside the working folder; the folder sat
  // one level up, on the Desktop.
  it("finds a folder that sits beside the working folder", async () => {
    await mkdir(join(home, "Desktop", "Atomic Agent"), { recursive: true });
    await mkdir(join(home, "Desktop", "backlinks_demo"));
    const found = await findPathCandidates(
      join(home, "Desktop", "Atomic Agent", "backlinks_demo"),
      roots(),
    );
    expect(found).toEqual([
      { path: join(home, "Desktop", "backlinks_demo"), kind: "folder" },
    ]);
  });

  it("matches the name ignoring case and reports files as files", async () => {
    await mkdir(join(home, "Documents", "notes"), { recursive: true });
    await writeFile(join(home, "Documents", "notes", "Report.PDF"), "x");
    const found = await findPathCandidates(join(home, "report.pdf"), roots());
    expect(found).toEqual([
      { path: join(home, "Documents", "notes", "Report.PDF"), kind: "file" },
    ]);
  });

  it("lists shallow matches first and each place once", async () => {
    await mkdir(join(home, "Downloads", "a", "b", "data"), { recursive: true });
    await mkdir(join(home, "Desktop", "data"), { recursive: true });
    const found = await findPathCandidates(join(home, "nowhere", "data"), roots());
    expect(found.map((c) => c.path)).toEqual([
      join(home, "Desktop", "data"),
      join(home, "Downloads", "a", "b", "data"),
    ]);
  });

  it("skips hidden folders, node_modules and Library", async () => {
    for (const parent of [".cache", "node_modules", "Library"]) {
      await mkdir(join(home, "Documents", parent, "target"), { recursive: true });
    }
    expect(await findPathCandidates(join(home, "x", "target"), roots())).toEqual([]);
  });

  it("stays within each root's depth", async () => {
    await mkdir(join(home, "Documents", "a", "b", "c", "deep"), { recursive: true });
    expect(await findPathCandidates(join(home, "deep"), roots())).toEqual([]);
  });

  it("stops at maxResults", async () => {
    for (const dir of ["a", "b", "c", "d"]) {
      await mkdir(join(home, "Desktop", dir, "same"), { recursive: true });
    }
    const found = await findPathCandidates(join(home, "same"), roots(), {
      ...DEFAULT_CANDIDATE_LIMITS,
      maxResults: 3,
    });
    expect(found).toHaveLength(3);
  });

  it("returns nothing, without throwing, for missing roots or a zero budget", async () => {
    await mkdir(join(home, "Desktop", "thing"), { recursive: true });
    expect(
      await findPathCandidates(join(home, "thing"), [
        { dir: join(home, "does-not-exist"), depth: 3 },
      ]),
    ).toEqual([]);
    expect(
      await findPathCandidates(join(home, "thing"), roots(), {
        ...DEFAULT_CANDIDATE_LIMITS,
        timeBudgetMs: 0,
      }),
    ).toEqual([]);
    expect(
      await findPathCandidates(join(home, "thing"), roots(), {
        ...DEFAULT_CANDIDATE_LIMITS,
        maxEntries: 0,
      }),
    ).toEqual([]);
  });
});

describe("candidateName", () => {
  it("takes the last segment and ignores a trailing separator", () => {
    expect(candidateName("/a/b/backlinks_demo/")).toBe("backlinks_demo");
    expect(candidateName("notes.txt")).toBe("notes.txt");
  });

  it("has nothing to look for at a root or a dot segment", () => {
    expect(candidateName("/")).toBeNull();
    expect(candidateName("a/..")).toBeNull();
  });
});
