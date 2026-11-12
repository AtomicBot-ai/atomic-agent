import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  candidateName,
  DEFAULT_CANDIDATE_LIMITS,
  findPathCandidates,
  type CandidateRoot,
} from "./path-candidates.js";

describe("findPathCandidates", () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "atomic-path-candidates-"));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const at = (dir: string, depth = 3): CandidateRoot => ({ dir: join(base, dir), depth });

  it("matches the name ignoring case and reports files as files", async () => {
    await mkdir(join(base, "docs", "notes"), { recursive: true });
    await writeFile(join(base, "docs", "notes", "Report.PDF"), "x");
    const search = await findPathCandidates(join(base, "report.pdf"), [at("docs")]);
    expect(search).toEqual({
      found: [{ path: join(base, "docs", "notes", "Report.PDF"), kind: "file" }],
      complete: true,
    });
  });

  it("compares names in NFC, so a decomposed name still matches", async () => {
    await mkdir(join(base, "docs", "Café"), { recursive: true });
    const { found } = await findPathCandidates(join(base, "café"), [at("docs")]);
    expect(found.map((c) => c.kind)).toEqual(["folder"]);
  });

  it("lists shallow matches first and each place once", async () => {
    await mkdir(join(base, "b", "x", "y", "data"), { recursive: true });
    await mkdir(join(base, "a", "data"), { recursive: true });
    const { found } = await findPathCandidates(join(base, "nowhere", "data"), [
      at("b"),
      at("a"),
      at("a", 1),
    ]);
    expect(found.map((c) => c.path)).toEqual([
      join(base, "a", "data"),
      join(base, "b", "x", "y", "data"),
    ]);
  });

  it("skips hidden folders, node_modules and Library", async () => {
    for (const parent of [".cache", "node_modules", "Library"]) {
      await mkdir(join(base, "docs", parent, "target"), { recursive: true });
    }
    const { found } = await findPathCandidates(join(base, "target"), [at("docs")]);
    expect(found).toEqual([]);
  });

  it("never lists or enters a blocked folder", async () => {
    await mkdir(join(base, "home", "Desktop", "thing"), { recursive: true });
    const blocked = [join(base, "home", "Desktop")];
    const below = await findPathCandidates(join(base, "thing"), [at("home")], undefined, {
      blocked,
    });
    expect(below.found).toEqual([]);
    const asRoot = await findPathCandidates(
      join(base, "thing"),
      [at("home/Desktop")],
      undefined,
      { blocked },
    );
    expect(asRoot.found).toEqual([]);
  });

  it("skips a match the filter rejects", async () => {
    await mkdir(join(base, "a", ".env"), { recursive: true });
    const { found } = await findPathCandidates(join(base, ".env"), [at("a")], undefined, {
      accept: () => false,
    });
    expect(found).toEqual([]);
  });

  it("stays within each root's depth", async () => {
    await mkdir(join(base, "docs", "a", "b", "c", "deep"), { recursive: true });
    const { found } = await findPathCandidates(join(base, "deep"), [at("docs")]);
    expect(found).toEqual([]);
  });

  it("stops at maxResults", async () => {
    for (const dir of ["a", "b", "c", "d"]) {
      await mkdir(join(base, "desk", dir, "same"), { recursive: true });
    }
    const { found } = await findPathCandidates(join(base, "same"), [at("desk")], {
      ...DEFAULT_CANDIDATE_LIMITS,
      maxResults: 3,
    });
    expect(found).toHaveLength(3);
  });

  // ATO-1333: the working folder in the system temp folder, whose ~20,000
  // entries used to spend the whole shared budget before the search
  // reached a match two levels below the working folder.
  it("a crowded outer root cannot starve the near search", async () => {
    await mkdir(join(base, "work", "projects", "target"), { recursive: true });
    await mkdir(join(base, "crowd"), { recursive: true });
    for (let i = 0; i < 40; i++) {
      await writeFile(join(base, "crowd", `entry-${i}`), "x");
    }
    const search = await findPathCandidates(
      join(base, "work", "target"),
      [{ ...at("crowd", 1), outer: true }, at("work")],
      {
        ...DEFAULT_CANDIDATE_LIMITS,
        maxEntries: 20,
        maxOuterEntries: 10,
        maxEntriesPerOuterDir: 10,
      },
    );
    expect(search.found).toEqual([
      { path: join(base, "work", "projects", "target"), kind: "folder" },
    ]);
    // The crowded folder was read only in part, so the search says it was cut.
    expect(search.complete).toBe(false);
  });

  it("lists near matches before outer ones, however shallow", async () => {
    await mkdir(join(base, "work", "a", "b", "same"), { recursive: true });
    await mkdir(join(base, "above", "same"), { recursive: true });
    const { found } = await findPathCandidates(join(base, "work", "same"), [
      { ...at("above", 1), outer: true },
      at("work"),
    ]);
    expect(found.map((c) => c.path)).toEqual([
      join(base, "work", "a", "b", "same"),
      join(base, "above", "same"),
    ]);
  });

  it("never throws, and says when a budget cut the search short", async () => {
    await mkdir(join(base, "desk", "thing"), { recursive: true });
    expect(
      await findPathCandidates(join(base, "thing"), [at("does-not-exist")]),
    ).toEqual({ found: [], complete: true });
    for (const cut of [{ timeBudgetMs: 0 }, { maxEntries: 0 }]) {
      expect(
        await findPathCandidates(join(base, "thing"), [at("desk")], {
          ...DEFAULT_CANDIDATE_LIMITS,
          ...cut,
        }),
      ).toEqual({ found: [], complete: false });
    }
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
