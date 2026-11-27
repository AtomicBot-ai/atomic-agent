import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expandMentions, hasContextMentions, type ContextMentionDeps } from "./context-mentions.js";
import { splitMentionedFiles } from "./mention-block.js";
import { UrlSkip } from "./mention-url.js";

let base: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "context-mentions-")));
  root = join(base, "project");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "one\ntwo\nthree\nfour\n");
  writeFileSync(join(base, "outside.ts"), "secret\n");
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function deps(over: Partial<ContextMentionDeps> = {}): ContextMentionDeps {
  return {
    runGit: vi.fn(async (_cwd: string, args: readonly string[]) => ({ text: args[0] === "log" ? "commit abc\n" : "diff --git a/x b/x\n", cut: false })),
    fetchUrl: vi.fn(async () => ({ text: "Page words", cut: false })),
    listFolder: vi.fn(async () => ["a.ts"]),
    ...over,
  };
}

describe("expandMentions", () => {
  it("inlines diff, git:N, a range, a folder and a link in one block", async () => {
    const d = deps();
    const out = await expandMentions("see @diff @git:2 @src/a.ts:2-3 @src/ @https://example.com/p", root, d);
    const split = splitMentionedFiles(out);
    expect(split?.typed).toBe("see @diff @git:2 @src/a.ts:2-3 @src/ @https://example.com/p");
    expect(out).toContain('<file path="diff">\ndiff --git a/x b/x\n</file>');
    expect(out).toContain('<file path="git:2">\ncommit abc\n</file>');
    expect(out).toContain('<file path="src/a.ts:2-3">\n2\ttwo\n3\tthree\n</file>');
    expect(out).toContain('<file path="src/">\nsrc/a.ts\n</file>');
    expect(out).toContain("Page words");
    expect(d.runGit).toHaveBeenCalledWith(root, expect.arrayContaining(["log", "-n2"]));
  });

  it("asks the problems source for @problems and says plainly when no server runs", async () => {
    const problems = vi.fn(async () => ({ state: "no_server" as const }));
    const out = await expandMentions("fix @problems", root, deps({ problems }));
    expect(problems).toHaveBeenCalledWith(root);
    expect(out).toContain("No language server is running for this folder.");
  });

  it("says language servers are off when there is no problems source", async () => {
    const out = await expandMentions("fix @problems", root, deps());
    expect(out).toContain("language servers are off");
  });

  it("says no problems found for a clean folder", async () => {
    const problems = async () => ({ state: "ok" as const, servers: ["typescript"], files: [] });
    expect(await expandMentions("@problems", root, deps({ problems }))).toContain("No problems found.");
  });

  it("keeps a real file named like a keyword a file mention", async () => {
    writeFileSync(join(root, "diff"), "the file\n");
    const d = deps();
    const out = await expandMentions("@diff", root, d);
    expect(out).toContain('<file path="diff">\nthe file\n</file>');
    expect(d.runGit).not.toHaveBeenCalled();
  });

  it("never reads a range or folder outside the working folder", async () => {
    const d = deps();
    const out = await expandMentions("@../outside.ts:1 @../ @/etc/", root, d);
    expect(out).toBe("@../outside.ts:1 @../ @/etc/");
    expect(d.listFolder).not.toHaveBeenCalled();
  });

  it("names a protected file in a range without inlining it", async () => {
    const d = deps({ isProtected: (real) => real.endsWith("a.ts") });
    const out = await expandMentions("@src/a.ts:1", root, d);
    expect(out).toContain("not inlined: the agent's own settings file is never inlined");
    expect(out).not.toContain("1\tone");
  });

  it("names a protected plain file without inlining it", async () => {
    const out = await expandMentions("@src/a.ts", root, deps({ isProtected: () => true }));
    expect(out).toContain("not inlined");
    expect(out).not.toContain("one\ntwo");
  });

  it("states why a link or git was not read", async () => {
    const d = deps({
      fetchUrl: async () => { throw new UrlSkip("offline mode is on"); },
      runGit: async () => { throw new Error("not a git repository"); },
    });
    const out = await expandMentions("@https://example.com @diff", root, d);
    expect(out).toContain("https://example.com (0 B, not inlined: offline mode is on)");
    expect(out).toContain("diff (0 B, not inlined: not a git checkout, or git failed)");
  });

  it("cuts an entry to the per-entry cap and says so", async () => {
    const big = "x".repeat(40 * 1024);
    const out = await expandMentions("@diff", root, deps({ runGit: async () => ({ text: big, cut: false }) }));
    expect(out).toContain("truncated to the first 32 KB");
  });
});

describe("hasContextMentions", () => {
  it("is true only for words the async expansion reads", () => {
    expect(hasContextMentions("explain @src/a.ts", root)).toBe(false);
    expect(hasContextMentions("plain text", root)).toBe(false);
    expect(hasContextMentions("see @diff", root)).toBe(true);
    expect(hasContextMentions("see @src/", root)).toBe(true);
    expect(hasContextMentions("see @problems.", root)).toBe(true);
  });
});
