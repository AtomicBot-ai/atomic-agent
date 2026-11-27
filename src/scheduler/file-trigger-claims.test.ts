import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTriggerClaims, FILE_TRIGGER_CLAIMS_DIR } from "./file-trigger-claims.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "file-trigger-claims-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("file trigger claims (ATO-2508)", () => {
  it("lets exactly one of two processes on one state dir claim a hit", () => {
    const a = createFileTriggerClaims({ stateDir: dir });
    const b = createFileTriggerClaims({ stateDir: dir });
    const key = "inbox|/home/user/Inbox/scan.pdf|1700000000000|4";
    expect(a.claim(key)).toBe(true);
    expect(b.claim(key)).toBe(false);
    expect(a.claim(key)).toBe(false);
    expect(readdirSync(join(dir, FILE_TRIGGER_CLAIMS_DIR))).toHaveLength(1);
  });

  it("treats a new write to the same file as a new hit", () => {
    const a = createFileTriggerClaims({ stateDir: dir });
    const b = createFileTriggerClaims({ stateDir: dir });
    expect(a.claim("inbox|/x/a.pdf|1|4")).toBe(true);
    expect(b.claim("inbox|/x/a.pdf|2|9")).toBe(true);
    expect(b.claim("other|/x/a.pdf|1|4")).toBe(true);
  });

  it("prunes records older than the time to live", () => {
    const first = createFileTriggerClaims({ stateDir: dir });
    expect(first.claim("k")).toBe(true);
    const later = createFileTriggerClaims({ stateDir: dir, now: () => Date.now() + 2 * 60_000, ttlMs: 60_000 });
    expect(later.claim("k")).toBe(true);
  });

  it("fails open when the state dir cannot hold the folder", () => {
    const notADir = join(dir, "file");
    writeFileSync(notADir, "");
    const claims = createFileTriggerClaims({ stateDir: notADir });
    expect(claims.claim("k")).toBe(true);
    expect(claims.claim("k")).toBe(true);
  });
});
