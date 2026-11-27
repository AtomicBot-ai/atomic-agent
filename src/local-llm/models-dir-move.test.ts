import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isFolderJunk, isSameOrInside, moveModelsDir, ModelsDirMoveError } from "./models-dir-move.js";

function exdev(): NodeJS.ErrnoException {
  const err = new Error("cross-device link not permitted") as NodeJS.ErrnoException;
  err.code = "EXDEV";
  return err;
}

describe("moveModelsDir (ATO-2106)", () => {
  let root: string;
  let from: string;
  let to: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "atomic-models-move-"));
    from = join(root, "old", "models");
    to = join(root, "external", "models");
    mkdirSync(join(from, "qwen-a"), { recursive: true });
    mkdirSync(join(from, "qwen-b"), { recursive: true });
    writeFileSync(join(from, "qwen-a", "a.gguf"), "aaaa");
    writeFileSync(join(from, "qwen-b", "b.gguf"), "bbbbbbbb");
    writeFileSync(join(from, "qwen-b", "b.gguf.part"), "pp");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("renames every model folder into the new folder and runs commit once", async () => {
    let commits = 0;
    const seen: string[] = [];
    const result = await moveModelsDir(from, to, {
      commit: () => void (commits += 1),
      onProgress: (p) => seen.push(`${p.entry} ${p.index}/${p.total}`),
    });
    expect(commits).toBe(1);
    expect(result.moved).toEqual(["qwen-a", "qwen-b"]);
    expect(seen).toEqual(["qwen-a 1/2", "qwen-b 2/2"]);
    expect(readFileSync(join(to, "qwen-a", "a.gguf"), "utf8")).toBe("aaaa");
    expect(existsSync(join(to, "qwen-b", "b.gguf.part"))).toBe(true);
    expect(existsSync(join(from, "qwen-a"))).toBe(false);
  });

  it("copies across disks (EXDEV) and deletes the source only after commit", async () => {
    let sourceAtCommit = false;
    const result = await moveModelsDir(from, to, {
      rename: async () => {
        throw exdev();
      },
      commit: () => {
        sourceAtCommit = existsSync(join(from, "qwen-a", "a.gguf"));
      },
    });
    expect(sourceAtCommit).toBe(true);
    expect(result.leftovers).toEqual([]);
    expect(readFileSync(join(to, "qwen-b", "b.gguf"), "utf8")).toBe("bbbbbbbb");
    expect(existsSync(join(from, "qwen-a"))).toBe(false);
    expect(existsSync(join(from, "qwen-b"))).toBe(false);
  });

  it("puts everything back when commit fails", async () => {
    await expect(
      moveModelsDir(from, to, {
        commit: () => {
          throw new Error("config write failed");
        },
      }),
    ).rejects.toThrow("config write failed");
    expect(readFileSync(join(from, "qwen-a", "a.gguf"), "utf8")).toBe("aaaa");
    expect(existsSync(join(from, "qwen-b", "b.gguf"))).toBe(true);
    expect(existsSync(join(to, "qwen-a"))).toBe(false);
  });

  it("removes the copies when a cross-disk commit fails", async () => {
    await expect(
      moveModelsDir(from, to, {
        rename: async () => {
          throw exdev();
        },
        commit: () => {
          throw new Error("nope");
        },
      }),
    ).rejects.toThrow("nope");
    expect(existsSync(join(to, "qwen-a"))).toBe(false);
    expect(existsSync(join(from, "qwen-a", "a.gguf"))).toBe(true);
  });

  it("undoes earlier renames when a later entry cannot be moved", async () => {
    let commits = 0;
    const flaky = async (a: string, b: string) => {
      if (a.endsWith("qwen-b")) {
        const err = new Error("busy") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      await rename(a, b);
    };
    await expect(moveModelsDir(from, to, { rename: flaky, commit: () => void (commits += 1) })).rejects.toBeInstanceOf(
      ModelsDirMoveError,
    );
    expect(commits).toBe(0);
    expect(existsSync(join(from, "qwen-a", "a.gguf"))).toBe(true);
    expect(existsSync(join(to, "qwen-a"))).toBe(false);
  });

  it("refuses a new folder inside the current one", async () => {
    await expect(moveModelsDir(from, join(from, "nested"))).rejects.toThrow("inside the current models folder");
    expect(existsSync(join(from, "qwen-a", "a.gguf"))).toBe(true);
  });

  it("refuses a new folder that contains the current one", async () => {
    await expect(moveModelsDir(from, join(root, "old"))).rejects.toThrow("is inside the new folder");
  });

  it("refuses a new folder that is not empty and moves nothing", async () => {
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, "notes.txt"), "mine");
    await expect(moveModelsDir(from, to)).rejects.toThrow("is not empty");
    expect(existsSync(join(from, "qwen-a", "a.gguf"))).toBe(true);
    expect(existsSync(join(to, "qwen-a"))).toBe(false);
    expect(readFileSync(join(to, "notes.txt"), "utf8")).toBe("mine");
  });

  it("accepts a new folder that holds only .DS_Store", async () => {
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, ".DS_Store"), "");
    const result = await moveModelsDir(from, to);
    expect(result.moved).toEqual(["qwen-a", "qwen-b"]);
  });

  it("ATO-2742: accepts a new folder that holds only Windows, macOS and KDE junk files", async () => {
    mkdirSync(to, { recursive: true });
    for (const name of ["desktop.ini", "Thumbs.db", "ehthumbs.db", "._.DS_Store", ".directory", ".ds_store", "Desktop.ini"]) {
      writeFileSync(join(to, name), "");
    }
    const result = await moveModelsDir(from, to);
    expect(result.moved).toEqual(["qwen-a", "qwen-b"]);
  });

  it("ATO-2742: a junk name is matched whole, so a real file still counts", async () => {
    expect(isFolderJunk("Thumbs.db")).toBe(true);
    expect(isFolderJunk("DESKTOP.INI")).toBe(true);
    expect(isFolderJunk("thumbs.db.bak")).toBe(false);
    expect(isFolderJunk("my-desktop.ini")).toBe(false);
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, "desktop.ini"), "");
    writeFileSync(join(to, "notes.txt"), "mine");
    await expect(moveModelsDir(from, to)).rejects.toThrow("is not empty");
  });

  it("does not report folder junk of the current folder as left in place, any case", async () => {
    for (const name of [".DS_Store", "Thumbs.db", "desktop.ini"]) writeFileSync(join(from, name), "");
    const result = await moveModelsDir(from, to, {
      rename: async () => {
        throw exdev();
      },
    });
    expect(result.moved).toEqual(["qwen-a", "qwen-b"]);
    expect(result.skipped).not.toContain(".DS_Store");
    expect(result.skipped).not.toContain("Thumbs.db");
    expect(result.skipped).not.toContain("desktop.ini");
  });

  it("leaves foreign files and folders of the current folder where they are", async () => {
    writeFileSync(join(from, "tax-return.pdf"), "private");
    mkdirSync(join(from, "Photos"), { recursive: true });
    writeFileSync(join(from, "Photos", "cat.jpg"), "meow");
    mkdirSync(join(from, ".hidden"), { recursive: true });
    writeFileSync(join(from, ".hidden", "x.gguf"), "h");
    const result = await moveModelsDir(from, to, {
      rename: async () => {
        throw exdev();
      },
    });
    expect(result.moved).toEqual(["qwen-a", "qwen-b"]);
    expect(result.skipped).toEqual([".hidden", "Photos", "tax-return.pdf"]);
    expect(readFileSync(join(from, "tax-return.pdf"), "utf8")).toBe("private");
    expect(readFileSync(join(from, "Photos", "cat.jpg"), "utf8")).toBe("meow");
    expect(existsSync(join(to, "tax-return.pdf"))).toBe(false);
    expect(existsSync(join(to, "Photos"))).toBe(false);
    expect(existsSync(join(to, ".hidden"))).toBe(false);
  });

  it("moves nothing but still commits when the folder is the same", async () => {
    let commits = 0;
    const result = await moveModelsDir(from, join(from, "."), { commit: () => void (commits += 1) });
    expect(result.moved).toEqual([]);
    expect(commits).toBe(1);
  });

  it("commits for a current folder that does not exist yet", async () => {
    let commits = 0;
    const result = await moveModelsDir(join(root, "never"), to, { commit: () => void (commits += 1) });
    expect(result.moved).toEqual([]);
    expect(commits).toBe(1);
    expect(existsSync(to)).toBe(true);
  });
});

describe("isSameOrInside", () => {
  it("tells a sibling with a shared prefix from a child", () => {
    expect(isSameOrInside(join("a", "models", "x"), join("a", "models"))).toBe(true);
    expect(isSameOrInside(join("a", "models2"), join("a", "models"))).toBe(false);
    expect(isSameOrInside(join("a", "..models"), join("a"))).toBe(true);
  });
});
