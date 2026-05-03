import { describe, it, expect } from "vitest";
import {
  extractReasoning,
  parseToolCall,
  parseToolCalls,
  ToolCallParseError,
} from "./tool-call-grammar.js";

describe("parseToolCall", () => {
  it("parses a minimal valid tool call", () => {
    const out = parseToolCall(
      '{"tool":"browser.navigate","args":{"url":"https://example.com"}}',
    );
    expect(out.tool).toBe("browser.navigate");
    expect(out.args).toEqual({ url: "https://example.com" });
  });

  it("normalizes action alias with flat args when grammar is not enforced", () => {
    const raw = '\n\n{"action":"browser.navigate","url":"https://www.google.com"}';
    const out = parseToolCall(raw);
    expect(out.tool).toBe("browser.navigate");
    expect(out.args).toEqual({ url: "https://www.google.com" });
  });

  it("normalizes OpenAI-style name plus nested args", () => {
    const raw = `
{
  "name": "os.fs.read",
  "args": {
    "path": "foo.txt"
  }
}`;
    const out = parseToolCall(raw);
    expect(out.tool).toBe("os.fs.read");
    expect(out.args).toEqual({ path: "foo.txt" });
  });

  it("normalizes name alias with flat args", () => {
    const raw = '{"name":"os.fs.read","path":"foo.txt"}';
    const out = parseToolCall(raw);
    expect(out.tool).toBe("os.fs.read");
    expect(out.args).toEqual({ path: "foo.txt" });
  });

  it("normalizes tool plus flat fields without nested args", () => {
    const raw = '{"tool":"os.fs.write","path":"foo.txt","content":""}';
    const out = parseToolCall(raw);
    expect(out.tool).toBe("os.fs.write");
    expect(out.args).toEqual({ path: "foo.txt", content: "" });
  });

  it("normalizes OpenAI-style arguments object", () => {
    const raw = '{"tool":"finish","arguments":{"summary":"done"}}';
    const out = parseToolCall(raw);
    expect(out.tool).toBe("finish");
    expect(out.args).toEqual({ summary: "done" });
  });

  it("normalizes OpenAI-style arguments JSON string", () => {
    const raw = '{"tool":"finish","arguments":"{\\"summary\\":\\"ok\\"}"}';
    const out = parseToolCall(raw);
    expect(out.tool).toBe("finish");
    expect(out.args).toEqual({ summary: "ok" });
  });

  it("strips leading thinking / prose before the JSON object", () => {
    const raw = `<think>
The user wants the title. The summary says "Google".
However re-read ARIA.
</think>
{"tool":"finish","args":{"summary":"Google"}}`;
    const out = parseToolCall(raw);
    expect(out.tool).toBe("finish");
    expect(out.args).toEqual({ summary: "Google" });
    expect(out.reasoning).toContain("The user wants the title");
  });

  it("strips <think> even when it contains JSON-looking braces", () => {
    const raw = `<think>
Maybe I should emit {"tool":"noop"} first — no, finish it.
</think>
{"tool":"finish","args":{"summary":"ok"}}`;
    const out = parseToolCall(raw);
    expect(out.tool).toBe("finish");
    expect(out.args).toEqual({ summary: "ok" });
    expect(out.reasoning).toContain("Maybe I should emit");
  });

  it("rejects unclosed <think> with clear error (and preserves reasoning)", () => {
    const raw = `<think>
I'm thinking but got cut off mid-thought by n_predict limit`;
    expect(() => parseToolCall(raw)).toThrow(ToolCallParseError);
    const extracted = extractReasoning(raw);
    expect(extracted.body).toBe("");
    expect(extracted.reasoning).toContain("cut off mid-thought");
  });

  it("handles multiple <think> blocks and concatenates reasoning", () => {
    const raw = `<think>first thought</think>
<think>second thought</think>
{"tool":"finish","args":{"summary":"done"}}`;
    const out = parseToolCall(raw);
    expect(out.tool).toBe("finish");
    expect(out.reasoning).toBe("first thought\n\nsecond thought");
  });

  it("supports custom reasoning tags", () => {
    const raw = `<|channel>thought
first thought
<channel|>
{"tool":"finish","args":{"summary":"done"}}`;
    const out = parseToolCall(raw, {
      openTag: "<|channel>thought\n",
      closeTag: "<channel|>",
    });
    expect(out.tool).toBe("finish");
    expect(out.reasoning).toBe("first thought");
  });

  it("parses a reply tool-call", () => {
    const out = parseToolCall(
      '{"tool":"reply","args":{"text":"hello there, friend"}}',
    );
    expect(out.tool).toBe("reply");
    expect(out.args).toEqual({ text: "hello there, friend" });
  });

  it("parses an os.fs.grep tool-call with nested args", () => {
    const out = parseToolCall(
      '{"tool":"os.fs.grep","args":{"pattern":"foo","glob":["*.ts"],"outputMode":"files_with_matches"}}',
    );
    expect(out.tool).toBe("os.fs.grep");
    expect(out.args).toEqual({
      pattern: "foo",
      glob: ["*.ts"],
      outputMode: "files_with_matches",
    });
  });

  it("parses an os.fs.glob tool-call", () => {
    const out = parseToolCall(
      '{"tool":"os.fs.glob","args":{"pattern":"**/*.ts","limit":50}}',
    );
    expect(out.tool).toBe("os.fs.glob");
    expect(out.args).toEqual({ pattern: "**/*.ts", limit: 50 });
  });

  it("parses an os.fs.edit tool-call", () => {
    const out = parseToolCall(
      '{"tool":"os.fs.edit","args":{"path":"a.ts","oldString":"foo","newString":"bar"}}',
    );
    expect(out.tool).toBe("os.fs.edit");
    expect(out.args).toEqual({ path: "a.ts", oldString: "foo", newString: "bar" });
  });

  it("parses an os.fs.read_document tool-call with pagination args", () => {
    const out = parseToolCall(
      '{"tool":"os.fs.read_document","args":{"path":"/tmp/a.pdf","pagesFrom":2,"pagesTo":5,"maxPages":4}}',
    );
    expect(out.tool).toBe("os.fs.read_document");
    expect(out.args).toEqual({
      path: "/tmp/a.pdf",
      pagesFrom: 2,
      pagesTo: 5,
      maxPages: 4,
    });
  });

  it("parses an os.fs.archive.list tool-call", () => {
    const out = parseToolCall(
      '{"tool":"os.fs.archive.list","args":{"path":"pkg.zip"}}',
    );
    expect(out.tool).toBe("os.fs.archive.list");
    expect(out.args).toEqual({ path: "pkg.zip" });
  });

  it("parses an os.fs.archive.read_entry tool-call", () => {
    const out = parseToolCall(
      '{"tool":"os.fs.archive.read_entry","args":{"path":"pkg.zip","entry":"README.md"}}',
    );
    expect(out.tool).toBe("os.fs.archive.read_entry");
    expect(out.args).toEqual({ path: "pkg.zip", entry: "README.md" });
  });

  it("parses an os.fs.archive.extract tool-call with limits", () => {
    const out = parseToolCall(
      '{"tool":"os.fs.archive.extract","args":{"path":"pkg.zip","destDir":"./out","overwrite":true,"limits":{"maxEntries":5}}}',
    );
    expect(out.tool).toBe("os.fs.archive.extract");
    expect(out.args).toEqual({
      path: "pkg.zip",
      destDir: "./out",
      overwrite: true,
      limits: { maxEntries: 5 },
    });
  });

  it("parses an os.fs.hash tool-call", () => {
    const out = parseToolCall(
      '{"tool":"os.fs.hash","args":{"path":"a.bin","algorithm":"sha256"}}',
    );
    expect(out.tool).toBe("os.fs.hash");
    expect(out.args).toEqual({ path: "a.bin", algorithm: "sha256" });
  });

  it("parses an os.fs.diff tool-call", () => {
    const out = parseToolCall(
      '{"tool":"os.fs.diff","args":{"aPath":"a.txt","bPath":"b.txt","context":5}}',
    );
    expect(out.tool).toBe("os.fs.diff");
    expect(out.args).toEqual({ aPath: "a.txt", bPath: "b.txt", context: 5 });
  });

  it("parses an os.fs.patch tool-call", () => {
    const out = parseToolCall(
      '{"tool":"os.fs.patch","args":{"patch":"--- a\\n+++ b\\n@@","apply":false}}',
    );
    expect(out.tool).toBe("os.fs.patch");
    expect((out.args as { apply: boolean }).apply).toBe(false);
  });

  it("parses an os.fs.watch tool-call", () => {
    const out = parseToolCall(
      '{"tool":"os.fs.watch","args":{"path":".","timeoutMs":3000,"events":["add","change"]}}',
    );
    expect(out.tool).toBe("os.fs.watch");
    expect(out.args).toEqual({
      path: ".",
      timeoutMs: 3000,
      events: ["add", "change"],
    });
  });

  it("parses an os.fs.trash tool-call", () => {
    const out = parseToolCall(
      '{"tool":"os.fs.trash","args":{"paths":["/tmp/a.png","/tmp/b.png"]}}',
    );
    expect(out.tool).toBe("os.fs.trash");
    expect(out.args).toEqual({ paths: ["/tmp/a.png", "/tmp/b.png"] });
  });

  it("parses an os.git.status tool-call", () => {
    const out = parseToolCall('{"tool":"os.git.status","args":{}}');
    expect(out.tool).toBe("os.git.status");
  });

  it("parses an os.git.log tool-call", () => {
    const out = parseToolCall(
      '{"tool":"os.git.log","args":{"limit":5,"path":"src/a.ts"}}',
    );
    expect(out.tool).toBe("os.git.log");
    expect(out.args).toEqual({ limit: 5, path: "src/a.ts" });
  });

  it("parses an os.git.diff tool-call", () => {
    const out = parseToolCall(
      '{"tool":"os.git.diff","args":{"revisionRange":"HEAD~1..HEAD","staged":false}}',
    );
    expect(out.tool).toBe("os.git.diff");
  });

  it("parses an os.git.show tool-call", () => {
    const out = parseToolCall(
      '{"tool":"os.git.show","args":{"revision":"HEAD","patch":false}}',
    );
    expect(out.tool).toBe("os.git.show");
  });

  it("parses an os.git.blame tool-call", () => {
    const out = parseToolCall(
      '{"tool":"os.git.blame","args":{"path":"a.ts","startLine":10,"endLine":30}}',
    );
    expect(out.tool).toBe("os.git.blame");
  });

  it("parses an os.git.branch tool-call", () => {
    const out = parseToolCall(
      '{"tool":"os.git.branch","args":{"includeRemote":true,"pattern":"feature/*"}}',
    );
    expect(out.tool).toBe("os.git.branch");
  });

  it("parses an os.proc.list tool-call", () => {
    const out = parseToolCall(
      '{"tool":"os.proc.list","args":{"filter":"node","limit":50}}',
    );
    expect(out.tool).toBe("os.proc.list");
  });

  it("parses an os.proc.kill tool-call", () => {
    const out = parseToolCall(
      '{"tool":"os.proc.kill","args":{"pid":12345,"signal":"SIGTERM"}}',
    );
    expect(out.tool).toBe("os.proc.kill");
  });

  it("parses an os.http.request tool-call with nested headers and body", () => {
    const out = parseToolCall(
      '{"tool":"os.http.request","args":{"url":"https://api.example.com","method":"POST","headers":{"Authorization":"Bearer X"},"body":{"a":1}}}',
    );
    expect(out.tool).toBe("os.http.request");
    expect(out.args).toEqual({
      url: "https://api.example.com",
      method: "POST",
      headers: { Authorization: "Bearer X" },
      body: { a: 1 },
    });
  });

  it("extractReasoning passthrough when no think tags present", () => {
    const raw = '{"tool":"finish","args":{}}';
    const extracted = extractReasoning(raw);
    expect(extracted.reasoning).toBe("");
    expect(extracted.body).toBe(raw);
  });

  it("extractReasoning handles an unclosed custom reasoning block", () => {
    const extracted = extractReasoning("<|channel>thought\npending", {
      openTag: "<|channel>thought\n",
      closeTag: "<channel|>",
    });
    expect(extracted.body).toBe("");
    expect(extracted.reasoning).toBe("pending");
  });

  it("tolerates surrounding whitespace", () => {
    const out = parseToolCall('  \n{"tool":"finish","args":{}}\n  ');
    expect(out.tool).toBe("finish");
    expect(out.args).toEqual({});
  });

  it("rejects non-JSON input", () => {
    expect(() => parseToolCall("not json")).toThrow(ToolCallParseError);
  });

  it("rejects non-object / non-call-array root", () => {
    expect(() => parseToolCall("[1,2,3]")).toThrow(ToolCallParseError);
    expect(() => parseToolCall('"string"')).toThrow(ToolCallParseError);
  });

  it("accepts a single-element array (array-only grammar produces [{...}])", () => {
    const out = parseToolCall(
      '[{"tool":"os.fs.read","args":{"path":"a.ts"}}]',
    );
    expect(out.tool).toBe("os.fs.read");
    expect(out.args).toEqual({ path: "a.ts" });
  });

  it("attaches reasoning to the unwrapped solo call", () => {
    const raw = `<think>just one read</think>
[{"tool":"os.fs.read","args":{"path":"a.ts"}}]`;
    const out = parseToolCall(raw);
    expect(out.tool).toBe("os.fs.read");
    expect(out.reasoning).toBe("just one read");
  });

  it("rejects missing tool name", () => {
    expect(() => parseToolCall('{"args":{}}')).toThrow(ToolCallParseError);
  });

  it("rejects missing args or non-object args", () => {
    expect(() => parseToolCall('{"tool":"x"}')).toThrow(ToolCallParseError);
    expect(() => parseToolCall('{"tool":"x","args":[]}')).toThrow(
      ToolCallParseError,
    );
    expect(() => parseToolCall('{"tool":"x","args":"y"}')).toThrow(
      ToolCallParseError,
    );
  });

  it("accepts nested args payloads", () => {
    const raw =
      '{"tool":"skill.run_script","args":{"skill":"check-gmail","script":"count.sh","args":["-n","5"]}}';
    const out = parseToolCall(raw);
    expect(out.tool).toBe("skill.run_script");
    expect(out.args.args).toEqual(["-n", "5"]);
  });

  it("extracts JSON when prose precedes and args strings contain braces", () => {
    const raw = `preamble
{"tool":"finish","args":{"summary":"literal {}"}}`;
    const out = parseToolCall(raw);
    expect(out.tool).toBe("finish");
    expect(out.args).toEqual({ summary: "literal {}" });
  });
});

describe("parseToolCalls", () => {
  it("returns kind=single for a plain object", () => {
    const out = parseToolCalls(
      '{"tool":"os.fs.read","args":{"path":"a.ts"}}',
    );
    expect(out.kind).toBe("single");
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]!.tool).toBe("os.fs.read");
    expect(out.calls[0]!.args).toEqual({ path: "a.ts" });
  });

  it("returns kind=batch for a JSON array of calls", () => {
    const raw =
      '[{"tool":"os.fs.read","args":{"path":"a.ts"}},{"tool":"os.fs.read","args":{"path":"b.ts"}},{"tool":"os.fs.read","args":{"path":"c.ts"}}]';
    const out = parseToolCalls(raw);
    expect(out.kind).toBe("batch");
    expect(out.calls).toHaveLength(3);
    expect(out.calls.map((c) => c.tool)).toEqual([
      "os.fs.read",
      "os.fs.read",
      "os.fs.read",
    ]);
    expect(out.calls.map((c) => c.args.path)).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  });

  it("attaches reasoning once for the whole batch", () => {
    const raw = `<think>let me read three files in parallel</think>
[{"tool":"os.fs.read","args":{"path":"a.ts"}},{"tool":"os.fs.read","args":{"path":"b.ts"}}]`;
    const out = parseToolCalls(raw);
    expect(out.kind).toBe("batch");
    expect(out.reasoning).toBe("let me read three files in parallel");
    for (const call of out.calls) {
      expect(call.reasoning).toBeUndefined();
    }
  });

  it("rejects an empty array", () => {
    expect(() => parseToolCalls("[]")).toThrow(ToolCallParseError);
  });

  it("rejects an array entry that is not an object", () => {
    expect(() =>
      parseToolCalls('[{"tool":"x","args":{}},42]'),
    ).toThrow(ToolCallParseError);
  });

  it("rejects an array of malformed entries", () => {
    expect(() => parseToolCalls("[1,2,3]")).toThrow(ToolCallParseError);
  });

  it("legacy parseToolCall throws when given a batch", () => {
    const raw = '[{"tool":"os.fs.read","args":{"path":"a.ts"}},{"tool":"os.fs.read","args":{"path":"b.ts"}}]';
    expect(() => parseToolCall(raw)).toThrow(ToolCallParseError);
  });

  it("handles a heterogeneous batch (different tools)", () => {
    const raw =
      '[{"tool":"os.fs.read","args":{"path":"a.ts"}},{"tool":"os.fs.glob","args":{"pattern":"**/*.ts"}}]';
    const out = parseToolCalls(raw);
    expect(out.kind).toBe("batch");
    expect(out.calls.map((c) => c.tool)).toEqual([
      "os.fs.read",
      "os.fs.glob",
    ]);
  });

  it("handles a single-element array as a batch (kind=batch, length 1)", () => {
    const out = parseToolCalls('[{"tool":"os.fs.read","args":{"path":"a"}}]');
    expect(out.kind).toBe("batch");
    expect(out.calls).toHaveLength(1);
  });
});
