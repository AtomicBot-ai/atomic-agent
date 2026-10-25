import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildMcpToolNameRule } from "../../mcp/mcp-grammar-builder.js";
import {
  GEMMA4_THINK_PROFILE,
  PLAIN_INSTRUCT_PROFILE,
  QWEN_THINK_PROFILE,
} from "../model-profile.js";
import { buildGrammar, buildGrammarForTools, grammarToolNames } from "./build-grammar.js";
import { gbnfAccepts } from "./gbnf-test-helpers.js";
import { withoutReasoningPrelude } from "./reasoning-prelude.js";

const GRAMMAR_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../grammars/tool-call.gbnf");

const call = (tool: string, args: Record<string, unknown>): string => JSON.stringify([{ tool, args }]);
const read = (args: Record<string, unknown>): string => call("os.fs.read", args);
const write = (args: Record<string, unknown>): string => call("os.fs.write", args);

/**
 * Under the generic `object` rule `{"tool":"os.fs.read","args":{}}` was
 * legal, the same hole #830 closed for `os.shell.run` (ATO-909). The bar
 * is each tool's own check (`parseReadArgs`, `parseWriteArgs`): read
 * needs a non-empty `path`; write a non-empty `path` and a `content`
 * string, which may be empty. Anything else the tool accepts must stay
 * accepted.
 */
const REJECTED = [
  read({}),
  read({ path: "" }),
  read({ maxBytes: 4096 }),
  read({ path: 5 }),
  write({}),
  write({ path: "a.txt" }),
  write({ content: "x" }),
  write({ path: "", content: "x" }),
  write({ path: "a.txt", content: 5 }),
  write({ path: "a.txt", content: null }),
];

const ACCEPTED = [
  read({ path: "src/a.ts" }),
  read({ path: "a.ts", offset: -20, limit: 10, lineNumbers: true, maxBytes: 4096 }),
  read({ path: "\\\\server\\share\\notes.txt" }),
  read({ path: "C:\\Users\\me\\a b.txt" }),
  write({ path: "a.txt", content: "" }),
  write({ path: "a.txt", content: "line\n", mode: "append" }),
  write({ path: "a.py", content: "def f():", overwrite: true }),
];

const grammars = async (): Promise<Array<[string, string]>> => {
  const plain = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
  const qwen = withoutReasoningPrelude(await buildGrammar(QWEN_THINK_PROFILE));
  const gemma = withoutReasoningPrelude(await buildGrammar(GEMMA4_THINK_PROFILE));
  const names = ["os.fs.read", "os.fs.write", "os.fs.list"];
  return [
    ["plain", plain],
    ["qwen", qwen],
    ["gemma", gemma],
    ["plain per-request", buildGrammarForTools(plain, names)],
    ["gemma per-request", buildGrammarForTools(gemma, names)],
  ];
};

describe("os.fs.read and os.fs.write need their required args (ATO-909)", () => {
  it("rejects empty or incomplete args and accepts every shape the tools accept", async () => {
    for (const [id, grammar] of await grammars()) {
      for (const bad of REJECTED) expect(gbnfAccepts(grammar, "root", bad), `${id} ${bad}`).toBe(false);
      for (const good of ACCEPTED) expect(gbnfAccepts(grammar, "root", good), `${id} ${good}`).toBe(true);
    }
  });

  it("the static grammar file names neither tool through the generic branch", async () => {
    const grammar = await readFile(GRAMMAR_FILE, "utf8");
    const osToolLine = grammar.split("\n").find((l) => l.startsWith("os-tool ::=")) ?? "";
    expect(osToolLine).not.toContain('"fs.read"');
    expect(osToolLine).not.toContain('"fs.write"');
    expect(osToolLine).toContain('"fs.read_document"');
    expect(gbnfAccepts(grammar, "root", call("os.fs.read_document", { path: "a.pdf" }))).toBe(true);
    expect(grammar).toMatch(/^tool-call ::= reply-call \| shell-call \| fs-read-call \| fs-write-call \| other-call$/m);
  });

  it("keeps a reasoning profile's marker guard on the path, its first character included", async () => {
    for (const profile of [QWEN_THINK_PROFILE, GEMMA4_THINK_PROFILE]) {
      const g = await buildGrammar(profile);
      for (const bad of ['"<|channel>"', '"|>"', '"a<|b"', '"\\\\<|x"', '""']) {
        expect(gbnfAccepts(g, "required-string", bad), `${profile.id} ${bad}`).toBe(false);
      }
      for (const good of ['"a"', '"a|b"', '"\\\\server"', '"src/a<b.ts"']) {
        expect(gbnfAccepts(g, "required-string", good), `${profile.id} ${good}`).toBe(true);
      }
      expect(gbnfAccepts(g, "fs-write-args", '{"path":"a","content":"x<|channel>"}'), profile.id).toBe(false);
    }
  });

  it("survives a dynamic MCP rule", async () => {
    const rule = buildMcpToolNameRule([
      { server: "gh", rawName: "list", qualifiedName: "mcp.gh.list", description: "", inputSchema: { type: "object" }, resourceClass: "approval_gated" },
    ]);
    const g = await buildGrammar(PLAIN_INSTRUCT_PROFILE, undefined, { mcpToolNameRule: rule });
    expect(gbnfAccepts(g, "root", read({}))).toBe(false);
    expect(gbnfAccepts(g, "root", read({ path: "a" }))).toBe(true);
    expect(gbnfAccepts(g, "root", call("mcp.gh.list", {}))).toBe(true);
  });
});

describe("per-request narrowing keeps or drops the fs branches", () => {
  it("keeps the branches a request admits and lists them", async () => {
    const base = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const g = buildGrammarForTools(base, ["os.fs.read", "os.fs.write", "os.fs.list"]);
    expect(g).toMatch(/^tool-call ::= reply-call \| fs-read-call \| fs-write-call \| other-call$/m);
    expect(g).toMatch(/^tool-name ::= "\\"os\.fs\.list\\""$/m);
    expect(grammarToolNames(g)).toEqual(["os.fs.list", "os.fs.read", "os.fs.write", "reply"]);
  });

  it("drops a branch the request does not admit, so that tool cannot be emitted", async () => {
    const base = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const readOnly = buildGrammarForTools(base, ["os.fs.read", "os.fs.list"]);
    expect(readOnly).toMatch(/^tool-call ::= reply-call \| fs-read-call \| other-call$/m);
    expect(grammarToolNames(readOnly)).toEqual(["os.fs.list", "os.fs.read", "reply"]);
    expect(gbnfAccepts(readOnly, "root", read({ path: "a" }))).toBe(true);
    expect(gbnfAccepts(readOnly, "root", write({ path: "a", content: "x" }))).toBe(false);
    const listOnly = buildGrammarForTools(base, ["os.fs.list"]);
    expect(gbnfAccepts(listOnly, "root", read({ path: "a" }))).toBe(false);
  });

  it("dedicated tools only: no generic branch at all", async () => {
    const base = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const g = buildGrammarForTools(base, ["os.fs.write", "os.shell.run", "os.fs.read"]);
    expect(g).toMatch(/^tool-call ::= reply-call \| shell-call \| fs-read-call \| fs-write-call$/m);
    expect(grammarToolNames(g)).toEqual(["os.fs.read", "os.fs.write", "os.shell.run", "reply"]);
    expect(gbnfAccepts(g, "root", write({ path: "a", content: "" }))).toBe(true);
    expect(gbnfAccepts(g, "root", call("os.fs.list", { path: "." }))).toBe(false);
  });

  it("a base from before the fs branches keeps the names on the generic branch", async () => {
    const base = (await buildGrammar(PLAIN_INSTRUCT_PROFILE))
      .replace(/^tool-call ::= .*$/m, "tool-call ::= reply-call | shell-call | other-call")
      .replace(/^fs-(read|write)-call ::= .*\n/gm, "");
    const g = buildGrammarForTools(base, ["os.fs.read"]);
    expect(g).toMatch(/^tool-call ::= reply-call \| other-call$/m);
    expect(g).toMatch(/^tool-name ::= "\\"os\.fs\.read\\""$/m);
    expect(grammarToolNames(g)).toEqual(["os.fs.read", "reply"]);
  });
});
