import { describe, it, expect } from "vitest";
import {
  extractReasoning,
  parseToolCall,
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

  it("tolerates surrounding whitespace", () => {
    const out = parseToolCall('  \n{"tool":"finish","args":{}}\n  ');
    expect(out.tool).toBe("finish");
    expect(out.args).toEqual({});
  });

  it("rejects non-JSON input", () => {
    expect(() => parseToolCall("not json")).toThrow(ToolCallParseError);
  });

  it("rejects non-object root", () => {
    expect(() => parseToolCall("[1,2,3]")).toThrow(ToolCallParseError);
    expect(() => parseToolCall('"string"')).toThrow(ToolCallParseError);
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
