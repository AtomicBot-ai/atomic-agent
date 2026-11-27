import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { walkFolder, type WalkReport } from "./file-walker.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-file-walker-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function files(count: number, dir = root): void {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(dir, `note-${i}.md`), `note ${i}`);
}

async function walk(maxFiles: number): Promise<{ found: number; report: WalkReport }> {
  const report: WalkReport = { unreadable: [], truncated: false };
  const found = await walkFolder(root, { maxBytes: 1024, maxFiles, report });
  return { found: found.length, report };
}

describe("walkFolder file cap (ATO-1648)", () => {
  it("a folder with exactly maxFiles files is complete, not truncated", async () => {
    files(3);
    expect(await walk(3)).toEqual({ found: 3, report: { unreadable: [], truncated: false } });
  });

  it("one file more than maxFiles keeps maxFiles and reports truncated", async () => {
    files(4);
    expect(await walk(3)).toEqual({ found: 3, report: { unreadable: [], truncated: true } });
  });

  it("counts the extra file in a later subfolder too", async () => {
    files(3);
    files(1, join(root, "sub"));
    expect(await walk(4)).toMatchObject({ found: 4, report: { truncated: false } });
    expect(await walk(3)).toMatchObject({ found: 3, report: { truncated: true } });
  });

  it("files the index does not read do not count toward the cap", async () => {
    files(3);
    writeFileSync(join(root, "script.ts"), "export {};");
    writeFileSync(join(root, ".hidden.md"), "hidden");
    expect(await walk(3)).toMatchObject({ found: 3, report: { truncated: false } });
  });
});
