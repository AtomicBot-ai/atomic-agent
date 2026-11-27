import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changedFilesUnder, createMentionServices, protectedPathCheck } from "./mention-services.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "mention-services-")));
  writeFileSync(join(root, ".env"), "OPENAI_API_KEY=sk-test\n");
  writeFileSync(join(root, "a.ts"), "x\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("createMentionServices", () => {
  it("never inlines the agent's key file, even inside the working folder", async () => {
    const services = createMentionServices({ lspPool: () => null, protectedFiles: [join(root, ".env")] });
    const now = services.expandNow("look @.env", root);
    expect(now).toContain("not inlined");
    expect(now).not.toContain("sk-test");
    expect(await services.expand("look @.env @diff", root)).not.toContain("sk-test");
  });

  it("answers at once for plain files and leaves the rest to expand", () => {
    const services = createMentionServices({ lspPool: () => null, protectedFiles: [] });
    expect(services.expandNow("explain @a.ts", root)).toContain('<file path="a.ts">');
    expect(services.expandNow("explain @diff", root)).toBeNull();
  });

  it("reports language servers off without a pool", async () => {
    const services = createMentionServices({ lspPool: () => null, protectedFiles: [] });
    expect(await services.problems(root)).toEqual({ state: "off" });
  });
});

describe("protectedPathCheck", () => {
  it("matches by real path, without case on Windows, and skips code folders", () => {
    const check = protectedPathCheck([join(root, ".env"), `${join(root, "skills")}/`]);
    expect(check(join(root, ".env"))).toBe(true);
    expect(check(join(root, "skills"))).toBe(false);
    expect(protectedPathCheck(["C:\\State\\.env"], "win32")("c:\\state\\.ENV")).toBe(true);
  });
});

describe("changedFilesUnder", () => {
  it("joins tracked changes and untracked files once each", async () => {
    const git = vi.fn(async (_cwd: string, args: readonly string[]) => ({
      text: args[0] === "diff" ? "a.ts\0b.ts\0" : "b.ts\0new.ts\0",
      cut: false,
    }));
    expect(await changedFilesUnder(git, root)).toEqual(["a.ts", "b.ts", "new.ts"]);
  });

  it("answers nothing outside a checkout", async () => {
    expect(await changedFilesUnder(async () => { throw new Error("not a repo"); }, root)).toEqual([]);
  });
});
