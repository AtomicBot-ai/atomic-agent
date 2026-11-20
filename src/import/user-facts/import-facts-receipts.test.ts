import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deleteImportReceipt,
  importReceiptsDir,
  listImportReceipts,
  readImportReceipt,
  writeImportReceipt,
} from "./import-facts-receipts.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "import-receipts-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("import receipts (ATO-1617)", () => {
  it("writes, reads, lists newest first and deletes", () => {
    const a = writeImportReceipt(dir, { source: "claude", savedAt: 1000, profile: [{ key: "job", id: 4 }], noteIds: [7] });
    const b = writeImportReceipt(dir, { source: "chatgpt", savedAt: 2000, profile: [], noteIds: [9] });
    expect(a).toBe("facts-1000-claude");
    expect(readImportReceipt(dir, a!)).toEqual({ id: a, source: "claude", savedAt: 1000, profile: [{ key: "job", id: 4 }], noteIds: [7] });
    expect(listImportReceipts(dir).map((r) => r.id)).toEqual([b, a]);
    deleteImportReceipt(dir, a!);
    expect(readImportReceipt(dir, a!)).toBeNull();
  });

  it("an import that wrote nothing leaves no receipt", () => {
    expect(writeImportReceipt(dir, { source: "claude", savedAt: 1, profile: [], noteIds: [] })).toBeNull();
  });

  it("two imports in the same millisecond get different ids", () => {
    const r = { source: "claude" as const, savedAt: 5, profile: [], noteIds: [1] };
    expect(writeImportReceipt(dir, r)).toBe("facts-5-claude");
    expect(writeImportReceipt(dir, r)).toBe("facts-5-claude-2");
  });

  it("refuses path-shaped ids and skips broken files", () => {
    expect(readImportReceipt(dir, "../../etc/passwd")).toBeNull();
    writeImportReceipt(dir, { source: "claude", savedAt: 3, profile: [], noteIds: [1] });
    writeFileSync(join(importReceiptsDir(dir), "facts-4-claude.json"), "{not json");
    expect(listImportReceipts(dir).map((r) => r.id)).toEqual(["facts-3-claude"]);
    expect(readdirSync(importReceiptsDir(dir)).some((n) => n.endsWith(".tmp"))).toBe(false);
  });
});
