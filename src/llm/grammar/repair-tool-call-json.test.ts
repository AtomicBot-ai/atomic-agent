import { describe, expect, it } from "vitest";
import { JSON_FIX, mergeJsonRepair, repairJsonText } from "./repair-tool-call-json.js";
import { parseToolCalls, ToolCallParseError } from "./tool-call-grammar.js";

describe("repairJsonText (ATO-637)", () => {
  it("returns null for JSON that already parses", () => {
    expect(repairJsonText('[{"tool":"x","args":{}}]')).toBeNull();
    expect(repairJsonText("  {\n  \"a\": 1\n}  ")).toBeNull();
  });

  it("drops trailing commas before closers", () => {
    const fixed = repairJsonText('[{"tool":"os.fs.read","args":{"path":"a.ts",},},]');
    expect(fixed?.value).toEqual([{ tool: "os.fs.read", args: { path: "a.ts" } }]);
    expect(fixed?.fixes).toEqual([JSON_FIX.trailingComma]);
    expect(fixed?.closedString).toBe(false);
    expect(fixed?.closedBrackets).toBe(false);
  });

  it("keeps commas and quotes that sit inside strings", () => {
    const fixed = repairJsonText('{"text":"a, b,]","n":1,}');
    expect(fixed?.value).toEqual({ text: "a, b,]", n: 1 });
  });

  it("turns single-quoted strings into JSON strings", () => {
    const fixed = repairJsonText(`[{'tool': 'reply', 'args': {'text': 'say "hi" and it\\'s ok'}}]`);
    expect(fixed?.value).toEqual([
      { tool: "reply", args: { text: `say "hi" and it's ok` } },
    ]);
    expect(fixed?.fixes).toContain(JSON_FIX.singleQuotes);
  });

  it("escapes raw newlines and tabs inside strings, not between tokens", () => {
    const fixed = repairJsonText('{\n  "content": "line one\nline\ttwo"\n}');
    expect(fixed?.value).toEqual({ content: "line one\nline\ttwo" });
    expect(fixed?.fixes).toEqual([JSON_FIX.rawControl]);
  });

  it("strips a code fence", () => {
    const fixed = repairJsonText('```json\n[{"tool":"reply","args":{"text":"x"},}]\n```');
    expect(fixed?.value).toEqual([{ tool: "reply", args: { text: "x" } }]);
    expect(fixed?.fixes).toContain(JSON_FIX.codeFence);
  });

  it("closes brackets left open at the end and says so", () => {
    const fixed = repairJsonText('[{"tool":"os.fs.read","args":{"path":"a.ts"}');
    expect(fixed?.value).toEqual([{ tool: "os.fs.read", args: { path: "a.ts" } }]);
    expect(fixed?.closedBrackets).toBe(true);
    expect(fixed?.closedString).toBe(false);
  });

  it("closes an open string at the end and says so", () => {
    const fixed = repairJsonText('{"path":"widget.txt');
    expect(fixed?.value).toEqual({ path: "widget.txt" });
    expect(fixed?.closedString).toBe(true);
    expect(fixed?.closedBrackets).toBe(true);
  });

  it("gives up on a key with no value, a number at the cut, a mismatched closer, or text that is not JSON", () => {
    expect(repairJsonText('[{"tool":"x","args":{"path":')).toBeNull();
    expect(repairJsonText('[{"tool":"os.proc.kill","args":{"pid":12')).toBeNull();
    expect(repairJsonText('{"limit": 1 ')).toBeNull();
    expect(repairJsonText('[{"tool":"x"]')).toBeNull();
    expect(repairJsonText("{{garbage")).toBeNull();
    expect(repairJsonText("{ not json")).toBeNull();
    expect(repairJsonText("")).toBeNull();
  });

  it("merges reports from several argument strings", () => {
    const merged = mergeJsonRepair(
      { fixes: [JSON_FIX.trailingComma], closedString: false, closedBrackets: false },
      { fixes: [JSON_FIX.trailingComma, JSON_FIX.singleQuotes], closedString: false, closedBrackets: true },
    );
    expect(merged).toEqual({
      fixes: [JSON_FIX.trailingComma, JSON_FIX.singleQuotes],
      closedString: false,
      closedBrackets: true,
    });
  });
});

describe("parseToolCalls with repairJson", () => {
  const broken = '[{"tool":"os.fs.read","args":{"path":"a.ts",}}]';

  it("still throws without the option", () => {
    expect(() => parseToolCalls(broken)).toThrow(ToolCallParseError);
  });

  it("repairs the root and reports it on the batch", () => {
    const batch = parseToolCalls(broken, {}, { repairJson: true });
    expect(batch.calls).toEqual([{ tool: "os.fs.read", args: { path: "a.ts" } }]);
    expect(batch.jsonRepair?.fixes).toEqual([JSON_FIX.trailingComma]);
  });

  it("repairs a nested args string", () => {
    const raw = JSON.stringify([{ tool: "os.fs.read", args: "{'path': 'a.ts'}" }]);
    expect(() => parseToolCalls(raw)).toThrow(ToolCallParseError);
    const batch = parseToolCalls(raw, {}, { repairJson: true });
    expect(batch.calls[0]?.args).toEqual({ path: "a.ts" });
    expect(batch.jsonRepair?.fixes).toEqual([JSON_FIX.singleQuotes]);
  });

  it("repairs a root that never closed and marks it as closed", () => {
    const raw = '[{"tool":"os.fs.read","args":{"path":"src/a.ts"';
    expect(() => parseToolCalls(raw)).toThrow(/incomplete/);
    const batch = parseToolCalls(raw, {}, { repairJson: true });
    expect(batch.calls).toEqual([{ tool: "os.fs.read", args: { path: "src/a.ts" } }]);
    expect(batch.jsonRepair?.closedBrackets).toBe(true);
  });

  it("leaves a clean batch unmarked", () => {
    const batch = parseToolCalls('[{"tool":"reply","args":{"text":"hi"}}]', {}, { repairJson: true });
    expect(batch.jsonRepair).toBeUndefined();
  });

  it("keeps the original error when no repair helps", () => {
    expect(() => parseToolCalls("{{garbage", {}, { repairJson: true })).toThrow(ToolCallParseError);
  });
});
