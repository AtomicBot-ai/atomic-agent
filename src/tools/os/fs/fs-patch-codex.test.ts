import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCodexChunks,
  CodexPatchParseError,
  looksLikeCodexPatch,
  parseCodexPatch,
  planCodexPatch,
  seekSequence,
  type CodexChunk,
} from "./fs-patch-codex.js";

const patchOf = (...lines: string[]): string =>
  ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

function chunksOf(patch: string): CodexChunk[] {
  const [op] = parseCodexPatch(patch);
  if (op?.kind !== "update") throw new Error("expected one update");
  return op.chunks;
}

function applyOk(original: string, patch: string): string {
  const result = applyCodexChunks(original, chunksOf(patch));
  if (!result.ok) throw new Error(result.reason);
  return result.content;
}

describe("looksLikeCodexPatch", () => {
  it("spots the envelope, with surrounding blank lines or a heredoc wrapper", () => {
    expect(looksLikeCodexPatch(patchOf("*** Delete File: a"))).toBe(true);
    expect(looksLikeCodexPatch(`\n\n${patchOf("*** Delete File: a")}\n`)).toBe(true);
    expect(looksLikeCodexPatch(`<<'EOF'\n${patchOf("*** Delete File: a")}\nEOF`)).toBe(true);
    expect(looksLikeCodexPatch("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n")).toBe(false);
    expect(looksLikeCodexPatch("")).toBe(false);
  });
});

describe("parseCodexPatch", () => {
  it("parses add, delete, update and move in one patch", () => {
    const ops = parseCodexPatch(
      patchOf(
        "*** Add File: docs/new.md",
        "+# Title",
        "+",
        "+body",
        "*** Delete File: old.txt",
        "*** Update File: src/a.ts",
        "*** Move to: src/b.ts",
        "@@ function main() {",
        " const a = 1;",
        "-const b = 2;",
        "+const b = 3;",
        "@@",
        "-old tail",
        "+new tail",
        "*** End of File",
      ),
    );
    expect(ops).toEqual([
      { kind: "add", path: "docs/new.md", lines: ["# Title", "", "body"] },
      { kind: "delete", path: "old.txt" },
      {
        kind: "update",
        path: "src/a.ts",
        moveTo: "src/b.ts",
        chunks: [
          {
            context: "function main() {",
            oldLines: ["const a = 1;", "const b = 2;"],
            newLines: ["const a = 1;", "const b = 3;"],
            endOfFile: false,
            added: 1,
            removed: 1,
          },
          {
            context: null,
            oldLines: ["old tail"],
            newLines: ["new tail"],
            endOfFile: true,
            added: 1,
            removed: 1,
          },
        ],
      },
    ]);
  });

  it("lets the first hunk omit @@ and reads a bare empty line as empty context", () => {
    const chunks = chunksOf(
      patchOf("*** Update File: a.txt", " one", "", "-two", "+TWO"),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.oldLines).toEqual(["one", "", "two"]);
    expect(chunks[0]!.newLines).toEqual(["one", "", "TWO"]);
  });

  it("skips blank lines between file sections", () => {
    const ops = parseCodexPatch(
      patchOf("*** Update File: a.txt", "-a", "+b", "", "", "*** Delete File: c.txt", ""),
    );
    expect(ops.map((o) => o.kind)).toEqual(["update", "delete"]);
    const first = ops[0];
    if (first?.kind !== "update") throw new Error("expected an update first");
    expect(first.chunks[0]!.oldLines).toEqual(["a"]);
  });

  it("accepts CRLF input and a heredoc wrapper", () => {
    const text = ["apply_patch <<'EOF'", "*** Begin Patch", "*** Delete File: a", "*** End Patch", "EOF"].join("\r\n");
    expect(parseCodexPatch(text)).toEqual([{ kind: "delete", path: "a" }]);
  });

  it.each([
    ["no Begin Patch", "*** Update File: a\n-x\n+y\n*** End Patch", /line 1: the patch must start with "\*\*\* Begin Patch"/],
    ["no End Patch", "*** Begin Patch\n*** Delete File: a", /must end with "\*\*\* End Patch"/],
    ["no operations", patchOf(), /changes no files/],
    ["an unknown header", patchOf("*** Rename File: a"), /line 2: expected "\*\*\* Add File: "/],
    ["an update with no hunks", patchOf("*** Update File: a.txt"), /line 2: "\*\*\* Update File: a.txt" has no hunks/],
    ["an empty @@ hunk", patchOf("*** Update File: a.txt", "@@ x", "@@ y", "-a"), /empty hunk in "a.txt"/],
    ["a bad hunk line", patchOf("*** Update File: a.txt", "@@", "*bad"), /line 4: unexpected line in a hunk of "a.txt"/],
    ["an added line without +", patchOf("*** Add File: a.txt", "+ok", "missing plus"), /every line of an added file starts with '\+'/],
    ["a header with no path", patchOf("*** Delete File: "), /needs a path/],
    ["a dangling End of File", patchOf("*** Update File: a.txt", "*** End of File"), /must close a hunk/],
    ["a hunk after End of File without @@", patchOf("*** Update File: a.txt", "-a", "+b", "*** End of File", "-c"), /must start with "@@"/],
  ])("rejects %s", (_label, text, message) => {
    expect(() => parseCodexPatch(text)).toThrow(CodexPatchParseError);
    expect(() => parseCodexPatch(text)).toThrow(message);
  });
});

describe("applyCodexChunks", () => {
  it("replaces a line found by its context", () => {
    expect(
      applyOk("a\nb\nc\n", patchOf("*** Update File: f", " a", "-b", "+B", " c")),
    ).toBe("a\nB\nc\n");
  });

  it("applies several hunks in order, each searched after the last", () => {
    const original = "x = 1\nsep\nx = 1\nsep\n";
    const patch = patchOf(
      "*** Update File: f",
      "@@",
      "-x = 1",
      "+x = 2",
      "@@",
      "-x = 1",
      "+x = 3",
    );
    expect(applyOk(original, patch)).toBe("x = 2\nsep\nx = 3\nsep\n");
  });

  it("uses the @@ line to pick between identical blocks", () => {
    const original = [
      "function a() {",
      "  return 1;",
      "}",
      "function b() {",
      "  return 1;",
      "}",
      "",
    ].join("\n");
    const patch = patchOf("*** Update File: f", "@@ function b() {", "-  return 1;", "+  return 2;");
    expect(applyOk(original, patch)).toBe(
      ["function a() {", "  return 1;", "}", "function b() {", "  return 2;", "}", ""].join("\n"),
    );
  });

  it("anchors an End of File hunk to the end of the file", () => {
    const original = "tail\nmiddle\ntail\n";
    const patch = patchOf("*** Update File: f", "-tail", "+end", "*** End of File");
    expect(applyOk(original, patch)).toBe("tail\nmiddle\nend\n");
  });

  it("inserts a pure addition after its @@ line, or at the end without one", () => {
    expect(
      applyOk("import a\ncode\n", patchOf("*** Update File: f", "@@ import a", "+import b")),
    ).toBe("import a\nimport b\ncode\n");
    expect(applyOk("one\n", patchOf("*** Update File: f", "+two"))).toBe("one\ntwo\n");
  });

  it("tolerates trailing whitespace, indentation and typographic quotes", () => {
    expect(applyOk("value = 1   \n", patchOf("*** Update File: f", "-value = 1", "+value = 2"))).toBe(
      "value = 2\n",
    );
    expect(applyOk("    deep()\n", patchOf("*** Update File: f", "-deep()", "+    deeper()"))).toBe(
      "    deeper()\n",
    );
    expect(
      applyOk("say(“hi”) — ok\n", patchOf("*** Update File: f", '-say("hi") - ok', '+say("bye")')),
    ).toBe('say("bye")\n');
  });

  it("keeps CRLF line endings and a missing final newline", () => {
    expect(applyOk("a\r\nb\r\n", patchOf("*** Update File: f", "-b", "+c"))).toBe("a\r\nc\r\n");
    expect(applyOk("a\nb", patchOf("*** Update File: f", "-b", "+c"))).toBe("a\nc");
  });

  it("drops a trailing empty context line that stands for the final newline", () => {
    expect(applyOk("a\nb\n", patchOf("*** Update File: f", "-b", "+c", " "))).toBe("a\nc\n");
  });

  it("fails without changing anything when a hunk does not match", () => {
    const result = applyCodexChunks(
      "a\nb\n",
      chunksOf(patchOf("*** Update File: f", "-b", "+B", "@@", "-zzz", "+y")),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/^hunk 2: these lines were not found after the previous hunk: "zzz"/);
  });

  it("fails when the @@ line is not in the file", () => {
    const result = applyCodexChunks("a\n", chunksOf(patchOf("*** Update File: f", "@@ nope", "-a", "+b")));
    expect(!result.ok && result.reason).toMatch(/^hunk 1: the "@@ nope" line was not found/);
  });

  it("does not search backwards for a later hunk", () => {
    const result = applyCodexChunks(
      "first\nsecond\n",
      chunksOf(patchOf("*** Update File: f", "-second", "+2", "@@", "-first", "+1")),
    );
    expect(result.ok).toBe(false);
  });
});

describe("seekSequence", () => {
  it("prefers an exact match over a looser one earlier in the file", () => {
    expect(seekSequence(["x ", "x"], ["x"], 0, false)).toBe(1);
  });
  it("returns -1 for a pattern longer than the file", () => {
    expect(seekSequence(["a"], ["a", "b"], 0, false)).toBe(-1);
  });
});

describe("planCodexPatch", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-codex-plan-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("plans each operation against the disk without writing", async () => {
    await writeFile(join(dir, "keep.txt"), "a\nb\n");
    await writeFile(join(dir, "gone.txt"), "1\n2\n3\n");
    await writeFile(join(dir, "move.txt"), "m\n");
    const plans = await planCodexPatch(
      parseCodexPatch(
        patchOf(
          "*** Add File: sub/new.txt",
          "+hello",
          "*** Update File: keep.txt",
          "-b",
          "+B",
          "*** Delete File: gone.txt",
          "*** Update File: move.txt",
          "*** Move to: moved.txt",
          "-m",
          "+M",
        ),
      ),
      dir,
    );
    expect(plans.map((p) => [p.outcome.path, p.outcome.applied, p.outcome.action, p.after])).toEqual([
      ["sub/new.txt", true, "add", "hello\n"],
      ["keep.txt", true, "update", "a\nB\n"],
      ["gone.txt", true, "delete", null],
      ["moved.txt", true, "update", "M\n"],
      ["move.txt", true, "delete", null],
    ]);
    expect(plans[2]!.outcome.removedLines).toBe(3);
    expect(plans[3]!.outcome.movedFrom).toBe("move.txt");
    expect(plans[4]!.outcome.movedTo).toBe("moved.txt");
  });

  it("explains each file that cannot be patched", async () => {
    await writeFile(join(dir, "exists.txt"), "x\n");
    await writeFile(join(dir, "dest.txt"), "taken\n");
    await writeFile(join(dir, "src.txt"), "s\n");
    await mkdir(join(dir, "folder"));
    const plans = await planCodexPatch(
      parseCodexPatch(
        patchOf(
          "*** Add File: exists.txt",
          "+y",
          "*** Delete File: missing.txt",
          "*** Update File: folder",
          "-a",
          "+b",
          "*** Update File: src.txt",
          "*** Move to: dest.txt",
          "-s",
          "+t",
        ),
      ),
      dir,
    );
    expect(plans.map((p) => [p.outcome.path, p.outcome.applied, p.outcome.reason])).toEqual([
      ["exists.txt", false, "file already exists (use *** Update File to change it)"],
      ["missing.txt", false, "file does not exist"],
      ["folder", false, "target is not a regular file"],
      ["src.txt", false, "cannot move to dest.txt: it already exists"],
    ]);
  });

  it("refuses a file named twice", async () => {
    await writeFile(join(dir, "a.txt"), "a\n");
    const plans = await planCodexPatch(
      parseCodexPatch(patchOf("*** Update File: a.txt", "-a", "+b", "*** Delete File: ./a.txt")),
      dir,
    );
    expect(plans.every((p) => !p.outcome.applied)).toBe(true);
    expect(plans[0]!.outcome.reason).toMatch(/appears more than once/);
  });
});
