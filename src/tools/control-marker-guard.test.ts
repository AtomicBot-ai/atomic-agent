import { describe, expect, it } from "vitest";

import {
  CONTENT_ARGUMENTS,
  CONTROL_MARKERS,
  GENERIC_CONTROL_MARKER,
  describeCorruptedCall,
  findControlMarkers,
} from "./control-marker-guard.js";

/** The live call that motivated the guard: a thought channel opened mid-call. */
const LIVE_PATH =
  ".}}]<tool_call|>thought<|channel>thought---<channel|>";

describe("findControlMarkers", () => {
  it("flags the live Gemma 4 failure: channel markers inside a path", () => {
    const hits = findControlMarkers({ path: LIVE_PATH }, "os.fs.list");
    expect(hits).toEqual([
      {
        path: "path",
        marker: "<tool_call|>",
        index: 4,
        excerpt: ".}}]<tool_call|>thought<|channel…",
      },
    ]);
  });

  it("flags every marker of every family anywhere in a non-content argument", () => {
    for (const marker of CONTROL_MARKERS) {
      const hits = findControlMarkers(
        { command: `echo before ${marker} after` },
        "os.shell.run",
      );
      expect(hits, marker).toHaveLength(1);
      expect(hits[0]!.marker, marker).toBe(marker);
      expect(hits[0]!.index, marker).toBe("echo before ".length);
    }
  });

  it("flags the generic <|name|> form whatever the family", () => {
    for (const marker of ["<|eot_id|>", "<|assistant|>", "<|end|>"]) {
      expect(GENERIC_CONTROL_MARKER.test(marker), marker).toBe(true);
      const hits = findControlMarkers({ url: `https://x/${marker}` });
      expect(hits.map((h) => h.marker), marker).toEqual([marker]);
    }
  });

  it("walks nested objects and arrays and names the path of each hit", () => {
    const hits = findControlMarkers({
      paths: ["clean", "<|im_start|>bad"],
      options: { nested: { id: "x<end_of_turn>" } },
      count: 3,
      flag: null,
    });
    expect(hits.map((h) => [h.path, h.marker])).toEqual([
      ["paths[1]", "<|im_start|>"],
      ["options.nested.id", "<end_of_turn>"],
    ]);
  });

  it("reports one hit per value — the earliest marker — with a windowed excerpt", () => {
    const value = `${"x".repeat(20)}<think>middle</think>${"y".repeat(40)}`;
    const hits = findControlMarkers({ pattern: value }, "os.fs.grep");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ marker: "<think>", index: 20 });
    expect(hits[0]!.excerpt).toBe("…xxxxxxxx<think>middle</think>yy…");
  });

  it("keeps the excerpt on one line", () => {
    const hits = findControlMarkers({ path: "a\n\t<|turn>\r\nb" });
    expect(hits[0]!.excerpt).toBe("a\\n\\t<|turn>\\r\\nb");
  });

  it("returns nothing for a clean call", () => {
    expect(
      findControlMarkers(
        { path: "src/index.ts", offset: 1, tags: ["a<b", "a|b", "<b>"] },
        "os.fs.read",
      ),
    ).toEqual([]);
  });

  describe("file content: only a marker at the start of a line", () => {
    it("lists the writing tools' content arguments", () => {
      expect([...CONTENT_ARGUMENTS.entries()].map(([t, k]) => [t, [...k]])).toEqual([
        ["os.fs.write", ["content"]],
        ["os.fs.edit", ["oldString", "newString"]],
        ["os.fs.patch", ["patch"]],
      ]);
    });

    it("does not flag source that mentions a marker mid-line", () => {
      const content = [
        "// the model wraps reasoning in <think> … </think> tags",
        "const open = '<|channel>';",
        "if (a<b && x<|y || a|b) return '<b>';",
        "const chatml = `<|im_start|>user`;",
      ].join("\n");
      expect(findControlMarkers({ path: "a.ts", content }, "os.fs.write")).toEqual(
        [],
      );
      expect(
        findControlMarkers(
          { path: "a.ts", oldString: "x <think> y", newString: "x </think> y" },
          "os.fs.edit",
        ),
      ).toEqual([]);
    });

    it("flags a line that starts with a marker — transcript markup, not content", () => {
      const content = "const a = 1;\n<|channel>thought\nI should…<channel|>\n";
      const hits = findControlMarkers({ path: "a.ts", content }, "os.fs.write");
      expect(hits).toEqual([
        {
          path: "content",
          marker: "<|channel>",
          index: 13,
          // 8 chars before the marker, 16 after it, cut marks where cut.
          excerpt: "… a = 1;\\n<|channel>thought\\nI should…",
        },
      ]);
      expect(
        findControlMarkers(
          { path: "a.ts", oldString: "x", newString: "</think>\nfoo" },
          "os.fs.edit",
        ).map((h) => h.path),
      ).toEqual(["newString"]);
      // The first line is a line start too.
      expect(
        findControlMarkers({ path: "a.md", content: "<think>hello" }, "os.fs.write"),
      ).toHaveLength(1);
    });

    it("reads a unified diff's line start after its +/-/space prefix", () => {
      const clean = [
        "--- a/x.ts",
        "+++ b/x.ts",
        "@@ -1,2 +1,2 @@",
        " const keep = '<think>';",
        "-const old = 1; // <|turn>",
        "+const now = 2; // <turn|>",
      ].join("\n");
      expect(findControlMarkers({ patch: clean }, "os.fs.patch")).toEqual([]);
      const corrupted = `${clean}\n+<|channel>thought\n`;
      const hits = findControlMarkers({ patch: corrupted }, "os.fs.patch");
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        path: "patch",
        marker: "<|channel>",
        index: corrupted.indexOf("<|channel>"),
      });
      // A bare line start (no diff prefix) is caught as well.
      expect(
        findControlMarkers({ patch: `${clean}\n<|channel>x` }, "os.fs.patch"),
      ).toHaveLength(1);
    });

    it("applies the line-start rule to the content argument only, not to the path beside it", () => {
      const hits = findControlMarkers(
        { path: "a<|channel>.ts", content: "mid <think> line" },
        "os.fs.write",
      );
      expect(hits.map((h) => h.path)).toEqual(["path"]);
    });

    it("checks the same key anywhere when the tool is not a writing tool", () => {
      expect(
        findControlMarkers({ content: "mid <think> line" }, "memory.notes.store"),
      ).toHaveLength(1);
      expect(findControlMarkers({ content: "mid <think> line" })).toHaveLength(1);
    });
  });
});

describe("describeCorruptedCall", () => {
  it("names the argument, the marker, its offset and the excerpt, and says the call did not run", () => {
    const hits = findControlMarkers({ path: LIVE_PATH }, "os.fs.list");
    expect(describeCorruptedCall(hits)).toBe(
      'corrupted tool call: argument `path` contains a model control marker (`<tool_call|>` at char 4: ".}}]<tool_call|>thought<|channel…"). The call was not run — re-emit it with clean arguments.',
    );
  });

  it("lists several arguments and counts the rest past three", () => {
    const hits = findControlMarkers({
      a: "<think>",
      b: "<think>",
      c: "<think>",
      d: "<think>",
      e: "<think>",
    });
    const message = describeCorruptedCall(hits);
    expect(message).toContain("argument `a` contains");
    expect(message).toContain("; argument `c` contains");
    expect(message).not.toContain("argument `d`");
    expect(message).toContain("; and 2 more argument(s). The call was not run");
  });
});
