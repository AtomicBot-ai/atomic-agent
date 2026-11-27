import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { APP_VERSIONS_DIRNAME, keepCurrentPage, listAppVersions, pruneAppVersions, readAppVersion } from "./app-versions.js";

function appFolder(page = "<p>now</p>"): string {
  const dir = mkdtempSync(join(tmpdir(), "atomic-app-versions-"));
  writeFileSync(join(dir, "index.html"), page);
  return dir;
}

describe("app versions (ATO-2459)", () => {
  it("keeps the current page under the next number, dated when that page was written", () => {
    const dir = appFolder("<p>one</p>");
    const at = new Date(Date.UTC(2026, 10, 20, 9, 30));
    utimesSync(join(dir, "index.html"), at, at);
    expect(keepCurrentPage(dir)).toEqual({ version: 1, savedAt: at.toISOString(), bytes: 10 });
    writeFileSync(join(dir, "index.html"), "<p>two</p>");
    expect(keepCurrentPage(dir)?.version).toBe(2);
    expect(listAppVersions(dir).map((v) => v.version)).toEqual([2, 1]);
    expect(readAppVersion(dir, 1)).toBe("<p>one</p>");
    expect(readAppVersion(dir, 3)).toBeNull();
    expect(readAppVersion(dir, "1")).toBeNull();
  });

  it("keeps nothing for an app with no page yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-app-versions-"));
    expect(keepCurrentPage(dir)).toBeNull();
    expect(listAppVersions(dir)).toEqual([]);
  });

  it("keeps only the newest N and ignores files it did not name", () => {
    const dir = appFolder();
    const v = join(dir, APP_VERSIONS_DIRNAME);
    mkdirSync(v);
    for (let i = 1; i <= 5; i++) writeFileSync(join(v, `${i}-${1000 + i}.html`), `<p>${i}</p>`);
    writeFileSync(join(v, "notes.txt"), "mine");
    writeFileSync(join(v, "0-1.html"), "not a version");
    pruneAppVersions(dir, 3);
    expect(listAppVersions(dir).map((x) => x.version)).toEqual([5, 4, 3]);
    expect(readdirSync(v)).toContain("notes.txt");
    expect(keepCurrentPage(dir, 3)?.version).toBe(6);
    expect(listAppVersions(dir).map((x) => x.version)).toEqual([6, 5, 4]);
  });
});
