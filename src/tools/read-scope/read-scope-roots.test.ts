import { describe, expect, it } from "vitest";

import {
  assistantReplyTurn,
  assistantToolCallTurn,
  toolResultTurn,
  userTurn,
} from "../../session/conversation-turn.js";
import { pathsNamedIn, userNamedPaths } from "./read-scope-roots.js";

const home = "/Users/someone";
const posixOnly = process.platform === "win32";

describe.skipIf(posixOnly)("paths the user named", () => {
  it("finds absolute and ~-prefixed paths, expanding ~ to the home directory", () => {
    expect(
      pathsNamedIn("summarize ~/Desktop/report.pdf and /srv/data/log.txt", {
        home,
      }),
    ).toEqual(["/Users/someone/Desktop/report.pdf", "/srv/data/log.txt"]);
    expect(pathsNamedIn("look in ~ for it", { home })).toEqual([home]);
  });

  it("keeps a quoted path whole, spaces included", () => {
    expect(
      pathsNamedIn(`open "~/My Documents/report v2.pdf" please`, { home }),
    ).toEqual(["/Users/someone/My Documents/report v2.pdf"]);
    expect(pathsNamedIn("read '/tmp/a b/c.txt' now", { home })).toEqual([
      "/tmp/a b/c.txt",
    ]);
    expect(pathsNamedIn("run `~/bin/tool`", { home })).toEqual([
      "/Users/someone/bin/tool",
    ]);
  });

  it("scans a quoted span that is not itself a path word by word", () => {
    expect(pathsNamedIn(`he said "check /tmp/x and /tmp/y"`, { home })).toEqual(
      ["/tmp/x", "/tmp/y"],
    );
  });

  it("strips the punctuation a sentence glues on", () => {
    expect(
      pathsNamedIn(
        "compare /tmp/a.txt, /tmp/b.txt; then (~/notes/todo.md) — done?",
        { home },
      ),
    ).toEqual(["/tmp/a.txt", "/tmp/b.txt", "/Users/someone/notes/todo.md"]);
    expect(pathsNamedIn("it is in /tmp/proj/src/.", { home })).toEqual([
      "/tmp/proj/src",
    ]);
  });

  it("ignores URLs, the bare root, relative paths and prose", () => {
    expect(
      pathsNamedIn(
        "see https://example.com/a/b and src/tools/x.ts, or / alone, and/or this",
        { home },
      ),
    ).toEqual([]);
  });

  it("recognises a Windows drive path as written", () => {
    expect(pathsNamedIn("open C:\\Users\\me\\file.txt", { home })).toEqual([
      "C:\\Users\\me\\file.txt",
    ]);
  });

  it("reads only user turns, deduplicates, and grows with the conversation", () => {
    const turns = [
      userTurn("summarize ~/Desktop/report.pdf"),
      assistantToolCallTurn({
        tool: "os.fs.read",
        args: { path: "/Users/other/secret.txt" },
      }),
      toolResultTurn({
        tool: "os.fs.read",
        status: "ok",
        summary: "/Users/other/leaked.txt",
      }),
      assistantReplyTurn("done; also see /Users/other/more.txt"),
      userTurn("and ~/Desktop/report.pdf again, plus /srv/data"),
    ];
    expect(userNamedPaths(turns, { home })).toEqual([
      "/Users/someone/Desktop/report.pdf",
      "/srv/data",
    ]);
    expect(userNamedPaths([], { home })).toEqual([]);
  });
});
