import { describe, expect, it } from "vitest";
import type { ToolCardEntry } from "../tui-state.js";
import {
  normalisePath,
  patchTargets,
  toolCardsAnnotation,
  toolCardsAnnotationParts,
} from "./tool-cards-annotation.js";

type Card = Pick<ToolCardEntry, "tool" | "args" | "status">;

function card(
  tool: string,
  args: Record<string, unknown> = {},
  status: Card["status"] = "ok",
): Card {
  return { tool, args, status };
}

describe("toolCardsAnnotation", () => {
  it("says nothing for zero or one call — the card already says it", () => {
    expect(toolCardsAnnotation([])).toBeNull();
    expect(toolCardsAnnotation([card("os.shell.run")])).toBeNull();
  });

  it("does not count the terminal reply / finish calls", () => {
    expect(
      toolCardsAnnotation([
        card("os.fs.read", { path: "a.ts" }),
        card("reply", { text: "done" }),
        card("finish"),
      ]),
    ).toBeNull();
  });

  it("groups calls into one line in a fixed order, whatever order they ran in", () => {
    const line = toolCardsAnnotation([
      card("os.shell.run", { command: "npm test" }),
      card("os.fs.edit", { path: "c.ts" }),
      card("os.fs.read", { path: "a.ts" }),
      card("os.shell.run", { command: "git status" }),
      card("os.fs.read", { path: "b.ts" }),
    ]);
    expect(line).toBe("read 2 files, edited 1 file, ran 2 commands");
  });

  it("counts files by distinct path, so a re-read is not a new file", () => {
    expect(
      toolCardsAnnotation([
        card("os.fs.read", { path: "a.ts" }),
        card("os.fs.read", { path: "a.ts" }),
        card("os.fs.read", { path: "a.ts" }),
      ]),
    ).toBe("read 1 file");
  });

  it("counts a call that names no path as one more file", () => {
    expect(
      toolCardsAnnotation([
        card("os.fs.patch", { patch: "--- a\n+++ b" }),
        card("os.fs.edit", { path: "x.ts" }),
      ]),
    ).toBe("edited 2 files");
  });

  it("names searches, git, web, memory and everything else", () => {
    expect(
      toolCardsAnnotation([
        card("os.fs.grep", { pattern: "foo" }),
        card("os.fs.glob", { pattern: "*.ts" }),
        card("os.git.status"),
        card("browser.navigate", { url: "https://example.com" }),
        card("os.http.request", { url: "https://example.com" }),
        card("memory.notes.recall", { query: "x" }),
        card("tasks.list"),
      ]),
    ).toBe(
      "ran 2 searches, ran 1 git command, 2 web steps, 1 memory call, 1 other tool call",
    );
  });

  it("counts only successful calls as work; failures are a separate count", () => {
    expect(
      toolCardsAnnotation([
        card("os.fs.read", { path: "a.ts" }, "error"),
        card("os.shell.run", { command: "false" }, "error"),
        card("os.shell.run", { command: "true" }),
      ]),
    ).toBe("ran 1 command · 2 failed");
    expect(
      toolCardsAnnotationParts([
        card("os.fs.read", { path: "a.ts" }, "error"),
        card("os.shell.run", { command: "false" }, "error"),
        card("os.shell.run", { command: "true" }),
      ]),
    ).toEqual({ done: "ran 1 command", failed: 2, unfinished: 0 });
  });

  it("shows only the failures when nothing succeeded", () => {
    expect(
      toolCardsAnnotation([
        card("os.fs.edit", { path: "a.ts" }, "error"),
        card("os.shell.run", { command: "false" }, "error"),
      ]),
    ).toBe("2 failed");
  });

  it("does not count a pending (stopped) call as done work", () => {
    expect(
      toolCardsAnnotation([
        card("os.fs.read", { path: "a.ts" }),
        card("os.fs.edit", { path: "a.ts" }, "pending"),
        card("os.shell.run", { command: "npm test" }, "error"),
      ]),
    ).toBe("read 1 file · 1 failed · 1 unfinished");
  });

  it("counts os.web.search / os.web.fetch as web steps, not other tools", () => {
    expect(
      toolCardsAnnotation([
        card("os.web.search", { query: "ink truncate" }),
        card("os.web.fetch", { url: "https://example.com" }),
      ]),
    ).toBe("2 web steps");
  });

  it("names a trash as its own step, counted by file", () => {
    expect(
      toolCardsAnnotation([
        card("os.fs.trash", { paths: ["a.log", "b.log", "./a.log"] }),
        card("os.fs.trash", { paths: ["c.log"] }),
        card("os.fs.edit", { path: "x.ts" }),
      ]),
    ).toBe("edited 1 file, moved 3 files to the trash");
  });

  it("names a move as its own step, counted by source file, single or batched", () => {
    expect(
      toolCardsAnnotation([
        card("os.fs.move", { from: "a.pdf", to: "Docs/" }),
        card("os.fs.move", {
          moves: [
            { from: "b.pdf", to: "Docs/" },
            { from: "./a.pdf", to: "Docs/" },
            { from: "c.jpg", to: "Images/" },
          ],
        }),
        card("os.fs.edit", { path: "x.ts" }),
      ]),
    ).toBe("edited 1 file, moved 3 files");
  });

  it("files read-only fs tools under read / search and GitHub on its own", () => {
    expect(
      toolCardsAnnotation([
        card("os.fs.diff", { aPath: "a.ts", bPath: "b.ts" }),
        card("os.fs.hash", { path: "a.ts" }),
        card("os.fs.watch", { path: "src" }),
        card("github.pr.list"),
        card("github.issue.create", { title: "x" }),
      ]),
    ).toBe("read 2 files, ran 1 search, 2 GitHub steps");
  });

  it("counts every file a multi-file patch touches", () => {
    const patch = [
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "--- a/src/two.ts\t2026-10-13 10:00:00",
      "+++ b/src/two.ts\t2026-10-13 10:00:01",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-a",
      "--- new.ts",
      "+++ new.ts",
    ].join("\n");
    expect(patchTargets(patch)).toEqual(["src/one.ts", "src/two.ts", "new.ts"]);
    expect(
      toolCardsAnnotation([
        card("os.fs.patch", { patch, apply: true }),
        card("os.fs.edit", { path: "./src/one.ts" }),
      ]),
    ).toBe("edited 3 files");
    // A patch read from a file names no target here: one file.
    expect(
      toolCardsAnnotation([
        card("os.fs.patch", { patchPath: "fix.diff", apply: true }),
        card("os.fs.edit", { path: "x.ts" }),
      ]),
    ).toBe("edited 2 files");
  });

  it("dedupes one file spelled with ./, trailing or doubled slashes", () => {
    expect(normalisePath("./src/a.ts")).toBe("src/a.ts");
    expect(normalisePath("src//a.ts/")).toBe("src/a.ts");
    expect(normalisePath("src/./a.ts")).toBe("src/a.ts");
    expect(normalisePath("/abs/dir/")).toBe("/abs/dir");
    expect(normalisePath("./")).toBe(".");
    expect(
      toolCardsAnnotation([
        card("os.fs.read", { path: "src/a.ts" }),
        card("os.fs.read", { path: "./src/a.ts" }),
        card("os.fs.read", { path: "src//a.ts" }),
      ]),
    ).toBe("read 1 file");
  });
});
