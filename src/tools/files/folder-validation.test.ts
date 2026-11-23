import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FolderRejectedError, type FolderErrorCode } from "./file-index-types.js";
import { isInside, validateFolder, type FolderValidationOptions } from "./folder-validation.js";

let root: string;
let docs: string;
let file: string;
let state: string;
// Temp folders sit under `/var` on macOS, which is a system folder.
const options = (): FolderValidationOptions => ({ systemDirs: [], protectedDirs: [state], home: join(root, "home") });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-folder-validation-")));
  docs = join(root, "docs");
  mkdirSync(join(docs, "inner"), { recursive: true });
  mkdirSync(join(root, "home"));
  state = join(root, "state");
  mkdirSync(state);
  file = join(root, "note.txt");
  writeFileSync(file, "x");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function codeOf(raw: unknown, added: string[] = [], opts: FolderValidationOptions = options()): Promise<FolderErrorCode | "ok"> {
  try {
    await validateFolder(raw, added, opts);
    return "ok";
  } catch (error) {
    if (error instanceof FolderRejectedError) return error.code;
    throw error;
  }
}

describe("validateFolder: one error code per reason", () => {
  it("accepts a real folder and answers its real path", async () => {
    await expect(validateFolder(`${docs}/`, [], options())).resolves.toBe(docs);
  });

  it("not_absolute: empty, relative or not a string", async () => {
    expect(await codeOf("")).toBe("not_absolute");
    expect(await codeOf("docs/inner")).toBe("not_absolute");
    expect(await codeOf("~/Documents")).toBe("not_absolute");
    expect(await codeOf(42)).toBe("not_absolute");
  });

  it("too_broad: the disk root, the home folder, homes root, system folders and the agent's state", async () => {
    expect(await codeOf("/")).toBe("too_broad");
    expect(await codeOf(join(root, "home"))).toBe("too_broad");
    expect(await codeOf("/Users")).toBe("too_broad");
    expect(await codeOf(state)).toBe("too_broad");
    expect(await codeOf(join(state, "skills"))).toBe("too_broad");
    const defaults = { home: join(root, "home") };
    expect(await codeOf("/etc", [], defaults)).toBe("too_broad");
    expect(await codeOf("/usr/share", [], defaults)).toBe("too_broad");
    expect(await codeOf("/System/Library", [], defaults)).toBe("too_broad");
  });

  it("not_found and not_a_directory", async () => {
    expect(await codeOf(join(root, "missing"))).toBe("not_found");
    expect(await codeOf(file)).toBe("not_a_directory");
  });

  it("already_added: the same folder, however it is spelled", async () => {
    expect(await codeOf(docs, [docs])).toBe("already_added");
    expect(await codeOf(join(docs, "inner", ".."), [docs])).toBe("already_added");
  });

  it("inside_added: a parent is already in the index; a parent of added folders is fine", async () => {
    expect(await codeOf(join(docs, "inner"), [docs])).toBe("inside_added");
    expect(await codeOf(docs, [join(docs, "inner")])).toBe("ok");
  });
});

describe("isInside", () => {
  it("is strict and does not match a sibling with the same prefix", () => {
    expect(isInside("/a/b/c", "/a/b", "linux")).toBe(true);
    expect(isInside("/a/b", "/a/b", "linux")).toBe(false);
    expect(isInside("/a/bc", "/a/b", "linux")).toBe(false);
    expect(isInside("/A/B/c", "/a/b", "darwin")).toBe(true);
    expect(isInside("/A/B/c", "/a/b", "linux")).toBe(false);
  });
});
