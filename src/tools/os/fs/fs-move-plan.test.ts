import * as fsPromises from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_MOVES_PER_CALL, parseMoveArgs } from "./fs-move-contract.js";
import { namesFolder, planMoves, type PlannedMove } from "./fs-move-plan.js";
import { describeMoves, previewMoves } from "./fs-move-text.js";

describe("parseMoveArgs", () => {
  it("takes a single move or a batch, never both", () => {
    expect(parseMoveArgs({ from: "a", to: "b" })).toEqual({
      moves: [{ from: "a", to: "b" }],
      overwrite: false,
    });
    expect(parseMoveArgs({ moves: [{ from: "a", to: "b/" }], overwrite: true })).toEqual({
      moves: [{ from: "a", to: "b/" }],
      overwrite: true,
    });
    expect(() => parseMoveArgs({ from: "a", to: "b", moves: [{ from: "c", to: "d" }] })).toThrow(
      "pass either `from` and `to`, or `moves` — not both",
    );
  });

  it("reads null as absent, the way a strict native-tools provider sends unused fields", () => {
    expect(parseMoveArgs({ from: null, to: null, moves: [{ from: "a", to: "b" }], overwrite: null })).toEqual({
      moves: [{ from: "a", to: "b" }],
      overwrite: false,
    });
    expect(parseMoveArgs({ from: "a", to: "b", moves: null })).toEqual({
      moves: [{ from: "a", to: "b" }],
      overwrite: false,
    });
  });

  it("names the bad entry and keeps overwrite strictly boolean", () => {
    expect(() => parseMoveArgs({ moves: [{ from: "a", to: "b" }, { from: "", to: "c" }] })).toThrow(
      "os.fs.move: moves[1] needs a non-empty `from` and `to`",
    );
    expect(() => parseMoveArgs({ moves: [] })).toThrow("`moves` must be a non-empty array");
    expect(() => parseMoveArgs({ to: "b" })).toThrow("`from` must be a non-empty string");
    expect(() => parseMoveArgs({ from: "a" })).toThrow("`to` must be a non-empty string");
    expect(parseMoveArgs({ from: "a", to: "b", overwrite: "yes" }).overwrite).toBe(false);
    const many = Array.from({ length: MAX_MOVES_PER_CALL + 1 }, (_, i) => ({ from: `${i}`, to: "x/" }));
    expect(() => parseMoveArgs({ moves: many })).toThrow(`at most ${MAX_MOVES_PER_CALL} moves per call`);
  });

  it("keeps Windows paths with spaces exactly as given", () => {
    const parsed = parseMoveArgs({
      from: "C:\\Users\\me\\Downloads\\Q1 report (final).pdf",
      to: "C:\\Users\\me\\Documents\\Reports 2026\\",
    });
    expect(parsed.moves[0]).toEqual({
      from: "C:\\Users\\me\\Downloads\\Q1 report (final).pdf",
      to: "C:\\Users\\me\\Documents\\Reports 2026\\",
    });
  });
});

describe("namesFolder", () => {
  it("treats a trailing backslash as a folder only on Windows", () => {
    expect(namesFolder("C:\\Docs\\Reports 2026\\", "win32")).toBe(true);
    expect(namesFolder("C:/Docs/Reports 2026/", "win32")).toBe(true);
    expect(namesFolder("C:\\Docs\\report.pdf", "win32")).toBe(false);
    expect(namesFolder("odd-name\\", "linux")).toBe(false);
    expect(namesFolder("Sorted/", "darwin")).toBe(true);
  });
});

describe("planMoves", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fs-move-plan-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const plan = (items: { from: string; to: string }[], overwrite = false) =>
    planMoves(items, { workingDir: dir, overwrite, fs: fsPromises });

  it("lands a file inside a folder named with a trailing separator, which need not exist", async () => {
    await writeFile(join(dir, "a.txt"), "a");
    const [move] = await plan([{ from: "a.txt", to: "new/deeper/" }]);
    expect(move).toMatchObject({ source: join(dir, "a.txt"), dest: join(dir, "new/deeper/a.txt"), replaces: false });
  });

  it("refuses moving a file onto itself", async () => {
    await writeFile(join(dir, "a.txt"), "a");
    await expect(plan([{ from: "a.txt", to: "./a.txt" }])).rejects.toThrow("is already at");
  });

  it("refuses a folder moved into itself through a symlinked parent", async () => {
    await mkdir(join(dir, "proj/sub"), { recursive: true });
    await symlink(join(dir, "proj/sub"), join(dir, "link"));
    await expect(plan([{ from: "proj", to: "link/copy" }])).rejects.toThrow("into itself");
  });

  it("refuses replacing a file with a folder even with overwrite", async () => {
    await mkdir(join(dir, "folder"));
    await writeFile(join(dir, "file.txt"), "f");
    await expect(plan([{ from: "folder", to: "file.txt" }], true)).rejects.toThrow(
      "will not replace the file",
    );
  });

  it("allows a case-only rename where the disk folds case", async () => {
    await writeFile(join(dir, "Photo.JPG"), "p");
    if (!existsSync(join(dir, "photo.jpg"))) return; // case-sensitive disk: nothing to prove
    const [move] = await plan([{ from: "Photo.JPG", to: "photo.jpg" }]);
    expect(move).toMatchObject({ dest: join(dir, "photo.jpg"), replaces: false });
  });

  it("refuses a chain whose result depends on order", async () => {
    await writeFile(join(dir, "a.txt"), "a");
    await writeFile(join(dir, "b.txt"), "b");
    await expect(
      plan([{ from: "a.txt", to: "b.txt" }, { from: "b.txt", to: "c.txt" }], true),
    ).rejects.toThrow("is both moved and moved onto");
  });
});

describe("approval card text", () => {
  const move = (source: string, dest: string, extra: Partial<PlannedMove> = {}): PlannedMove => ({
    from: source, to: dest, source, dest, folder: false, replaces: false, ...extra,
  });

  it("says what happens in the operator's terms", () => {
    expect(describeMoves([move("/w/a.txt", "/w/b.txt")])).toBe("rename a.txt to b.txt in /w");
    expect(describeMoves([move("/w/pics", "/w/Photos", { folder: true })])).toBe("rename folder pics to Photos in /w");
    expect(describeMoves([move("/w/a.txt", "/w/x/a.txt")])).toBe("move /w/a.txt to /w/x/a.txt");
    const sorted = Array.from({ length: 72 }, (_, i) => move(`/w/f${i}.pdf`, `/w/Sorted/f${i}.pdf`));
    expect(describeMoves(sorted)).toBe("move 72 items to /w/Sorted");
    expect(describeMoves([move("/w/a", "/w/x/a"), move("/w/b", "/w/y/b", { replaces: true })])).toBe(
      "move 2 items to 2 folders, replacing 1 existing file",
    );
    const preview = previewMoves(sorted).split("\n");
    expect(preview).toHaveLength(13);
    expect(preview[0]).toBe("/w/f0.pdf → /w/Sorted/f0.pdf");
    expect(preview[12]).toBe("… +60 more");
  });
});
