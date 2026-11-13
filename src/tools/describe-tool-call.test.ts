import { describe, expect, it } from "vitest";

import {
  MAX_LINE,
  describeToolCall,
  describeToolCalls,
  humanizeToolName,
  shortPath,
} from "./describe-tool-call.js";

const line = (name: string, args?: unknown, ok?: boolean) => describeToolCall({ name, args, ok }).line;

describe("describeToolCall (ATO-962)", () => {
  it("says a file read with the file's short name, in three tenses", () => {
    const args = { path: "/Users/someone/project/src/config.ts" };
    expect(describeToolCall({ name: "os.fs.read", args })).toEqual({
      verb: "Reading",
      line: "Reading config.ts",
      status: "running",
    });
    expect(describeToolCall({ name: "os.fs.read", args, ok: true })).toEqual({
      verb: "Read",
      line: "Read config.ts",
      status: "ok",
    });
    expect(describeToolCall({ name: "os.fs.read", args, ok: false, error: "ENOENT: no such file\nstack" })).toEqual({
      verb: "Couldn\u2019t read",
      line: "Couldn\u2019t read config.ts",
      detail: "ENOENT: no such file",
      status: "error",
    });
  });

  it("keeps the past tense for a command that ran and failed", () => {
    expect(line("os.shell.run", { cmd: "npm", args: ["test"] }, false)).toBe("Ran npm test \u00b7 failed");
    expect(line("os.shell.run", { cmd: "npm", args: ["test"] }, true)).toBe("Ran npm test");
    expect(line("os.shell.run", { cmd: "npm", args: ["test"] })).toBe("Running npm test");
  });

  it("trims a long command and counts the lines of a script", () => {
    const long = line("os.shell.run", { cmd: `echo ${"x".repeat(200)}` }, true);
    expect(long.length).toBeLessThanOrEqual(MAX_LINE);
    expect(long.endsWith("\u2026")).toBe(true);
    expect(line("os.shell.run", { cmd: "set -e\nnpm ci\nnpm test" }, true)).toBe("Ran set -e (+2 lines)");
  });

  it("reads the command as the shell tool does: aliases and argv arrays", () => {
    expect(line("os.shell.run", { command: "git status" }, true)).toBe("Ran git status");
    expect(line("os.shell.run", { cmd: ["ls", "-la"] }, true)).toBe("Ran ls -la");
  });

  it("names a patch's files from its headers, and both sides of a diff", () => {
    const patch = "--- a/src/x.ts\n+++ b/src/x.ts\n@@\n--- a/y.ts\n+++ b/y.ts\n";
    expect(line("os.fs.patch", { patch }, true)).toBe("Edited x.ts and 1 more");
    expect(line("os.fs.diff", { aPath: "a/one.txt", bPath: "b/two.txt" }, true)).toBe("Compared one.txt and two.txt");
  });

  it("reads args given as JSON text, and survives clipped JSON", () => {
    expect(line("os.fs.edit", '{"path":"src/a/b.tsx","old":"x"}', true)).toBe("Edited b.tsx");
    expect(line("os.fs.edit", '{"path":"src/a/b.t', true)).toBe("Edited a file");
  });

  it("covers the filesystem family", () => {
    expect(line("os.fs.write", { path: "notes.md" }, true)).toBe("Wrote notes.md");
    expect(line("os.fs.write", { path: "notes.md", mode: "append" }, true)).toBe("Added to notes.md");
    expect(line("os.fs.list", { path: "/repo/src/" }, true)).toBe("Listed files in src");
    expect(line("os.fs.list", {}, true)).toBe("Listed files");
    expect(line("os.fs.grep", { pattern: "TODO" }, true)).toBe("Searched files for \u201cTODO\u201d");
    expect(line("os.fs.glob", { pattern: "**/*.ts" }, true)).toBe("Looked for **/*.ts");
    expect(line("os.fs.move", { from: "a/x.txt", to: "b/y.txt" }, true)).toBe("Moved x.txt to y.txt");
    expect(line("os.fs.trash", { paths: ["a.txt", "b.txt", "c.txt"] }, true)).toBe("Moved a.txt and 2 more to the Trash");
    expect(line("os.fs.read_document", { path: "report.pdf" })).toBe("Reading report.pdf");
  });

  it("covers git, web, browser and http", () => {
    expect(line("os.git.status", {}, true)).toBe("Ran git status");
    expect(line("os.web.search", { query: "bun vs node" }, true)).toBe("Searched the web for \u201cbun vs node\u201d");
    expect(line("browser.search", { query: "q" })).toBe("Searching the web for \u201cq\u201d");
    expect(line("os.web.fetch", { url: "https://www.example.com/a/b" }, true)).toBe("Opened example.com");
    expect(line("browser.navigate", { url: "not a url/x" }, true)).toBe("Opened not a url");
    expect(line("os.http.request", { url: "https://api.github.com/x" }, false)).toBe("Couldn\u2019t call api.github.com");
    expect(line("browser.click", {}, true)).toBe("Clicked on the page");
  });

  it("covers memory, MCP, Composio, image, video and Fusion", () => {
    expect(line("memory.notes.store", { content: "likes tea" }, true)).toBe("Remembered \u201clikes tea\u201d");
    expect(line("memory.profile.set", { key: "home_city", value: "Tallinn" }, true)).toBe("Remembered your home city");
    expect(line("memory.notes.recall", { query: "tea" })).toBe("Recalling \u201ctea\u201d");
    expect(line("memory.notes.forget", {}, true)).toBe("Forgot something");
    expect(line("mcp.github.create_issue", {}, true)).toBe("Used github: create issue");
    expect(line("mcp.composio.GMAIL_SEND_EMAIL", {}, true)).toBe("Used Composio: gmail send email");
    expect(line("image.generate", { count: 2, prompt: "a cat" }, true)).toBe("Generated 2 images \u00b7 \u201ca cat\u201d");
    expect(line("video.generate", {}, true)).toBe("Generated a video");
    expect(line("audio.transcribe", { path: "voice.ogg" }, true)).toBe("Transcribed voice.ogg");
    expect(line("audio.transcribe", {})).toBe("Transcribing a recording");
    expect(line("fusion.delegate", { tasks: [{}, {}, {}] })).toBe("Delegating 3 tasks");
    expect(line("fusion_worker", {}, true)).toBe("Ran a worker");
  });

  it("humanizes an unknown tool instead of showing its raw name", () => {
    expect(line("acme.do_thing", {}, true)).toBe("Used acme do thing");
    expect(line("acme.do_thing")).toBe("Using acme do thing");
    expect(line("acme.do_thing", {}, false)).toBe("Couldn\u2019t use acme do thing");
    expect(line("", {}, true)).toBe("Used tool");
  });

  it("never throws on hostile args", () => {
    for (const args of [null, 42, [], "[]", { path: 7 }, { cmd: { x: 1 } }, { paths: [null, 3] }]) {
      expect(() => describeToolCall({ name: "os.fs.read", args })).not.toThrow();
      expect(() => describeToolCall({ name: "os.shell.run", args })).not.toThrow();
    }
  });

  it("keeps every line within MAX_LINE", () => {
    const huge = "y".repeat(500);
    for (const name of ["os.fs.read", "os.web.search", "memory.notes.store", "mcp.x." + huge, huge]) {
      const l = line(name, { path: huge, query: huge, content: huge }, true);
      expect(l.length).toBeLessThanOrEqual(MAX_LINE);
    }
  });
});

describe("shortPath / humanizeToolName", () => {
  it("shortens paths to the base name", () => {
    expect(shortPath("/a/b/c.ts")).toBe("c.ts");
    expect(shortPath("C:\\x\\y.txt")).toBe("y.txt");
    expect(shortPath(".")).toBe("this folder");
    expect(shortPath("src/")).toBe("src");
  });
  it("turns names into words", () => {
    expect(humanizeToolName("os.proc.list")).toBe("proc list");
    expect(humanizeToolName("mcp.docs.search")).toBe("docs search");
    expect(humanizeToolName("getUserInfo")).toBe("get user info");
  });
});

describe("describeToolCalls", () => {
  it("sums a run of calls into one line, in first-seen order", () => {
    expect(
      describeToolCalls([
        { name: "os.fs.read" },
        { name: "os.shell.run" },
        { name: "os.fs.read_document" },
        { name: "os.shell.run", ok: false },
        { name: "os.fs.read" },
      ]),
    ).toBe("Read 3 files, ran 2 commands");
    expect(describeToolCalls([{ name: "os.fs.grep" }, { name: "os.fs.list" }])).toBe("Ran 2 searches");
  });
  it("counts web searches, edits and other tools", () => {
    expect(
      describeToolCalls([
        { name: "os.web.search" },
        { name: "os.web.search" },
        { name: "os.fs.edit" },
        { name: "mcp.x.y" },
      ]),
    ).toBe("Searched the web twice, edited 1 file, used 1 other tool");
  });
  it("drops 'other' when it is the only kind, and ignores reply/finish", () => {
    expect(describeToolCalls([{ name: "mcp.a.b" }, { name: "mcp.a.c" }, { name: "reply" }])).toBe("Used 2 tools");
    expect(describeToolCalls([])).toBe("");
  });
});
