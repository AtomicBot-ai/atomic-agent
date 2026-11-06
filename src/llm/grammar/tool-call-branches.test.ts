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
  const names = ["os.fs.read", "os.fs.write", "os.fs.hash"];
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
    expect(grammar).toMatch(/^tool-call ::= reply-call \| shell-call \| fs-read-call \| fs-write-call \| fs-edit-call \| .* \| other-call$/m);
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

describe("a shell cmd may start with an escape", () => {
  it("accepts a cmd opening on an escape and still refuses an empty one", async () => {
    for (const [id, grammar] of await grammars()) {
      const g = buildGrammarForTools(grammar, ["os.shell.run"]);
      expect(gbnfAccepts(g, "root", call("os.shell.run", { cmd: "\\ls -la" })), id).toBe(true);
      expect(gbnfAccepts(g, "root", call("os.shell.run", { cmd: "\"quoted dir\"/run.sh" })), id).toBe(true);
      expect(gbnfAccepts(g, "root", call("os.shell.run", { cmd: "" })), id).toBe(false);
      expect(gbnfAccepts(g, "root", call("os.shell.run", {})), id).toBe(false);
    }
  });
});

describe("per-request narrowing keeps or drops the fs branches", () => {
  it("keeps the branches a request admits and lists them", async () => {
    const base = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const g = buildGrammarForTools(base, ["os.fs.read", "os.fs.write", "os.fs.hash"]);
    expect(g).toMatch(/^tool-call ::= reply-call \| fs-read-call \| fs-write-call \| other-call$/m);
    expect(g).toMatch(/^tool-name ::= "\\"os\.fs\.hash\\""$/m);
    expect(grammarToolNames(g)).toEqual(["os.fs.hash", "os.fs.read", "os.fs.write", "reply"]);
  });

  it("drops a branch the request does not admit, so that tool cannot be emitted", async () => {
    const base = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const readOnly = buildGrammarForTools(base, ["os.fs.read", "os.fs.hash"]);
    expect(readOnly).toMatch(/^tool-call ::= reply-call \| fs-read-call \| other-call$/m);
    expect(grammarToolNames(readOnly)).toEqual(["os.fs.hash", "os.fs.read", "reply"]);
    expect(gbnfAccepts(readOnly, "root", read({ path: "a" }))).toBe(true);
    expect(gbnfAccepts(readOnly, "root", write({ path: "a", content: "x" }))).toBe(false);
    const hashOnly = buildGrammarForTools(base, ["os.fs.hash"]);
    expect(gbnfAccepts(hashOnly, "root", read({ path: "a" }))).toBe(false);
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

/**
 * ATO-1114: the rest of the tools a small model reaches for in a coding or
 * file session. Each had only the generic `object`, so `{"args":{}}` was
 * legal and a 4–9B model took that way out. The bar is again each tool's
 * own check (`parseEditArgs`, `parseMoveArgs`, `parseListArgs`, the grep,
 * glob, web, http, skill/tool view, tool search and notes parsers): what it refuses
 * the grammar refuses, what it accepts stays accepted.
 */
const MORE_REJECTED = [
  call("os.fs.edit", {}),
  call("os.fs.edit", { path: "a.ts", oldString: "", newString: "x" }),
  call("os.fs.edit", { path: "a.ts", newString: "x" }),
  call("os.fs.edit", { path: "", oldString: "a", newString: "b" }),
  call("os.fs.edit", { path: "a.ts", oldString: "a" }),
  call("os.fs.move", {}),
  call("os.fs.move", { from: "a.txt" }),
  call("os.fs.move", { from: "", to: "b" }),
  call("os.fs.move", { moves: [] }),
  call("os.fs.move", { moves: [{ from: "a" }] }),
  call("os.fs.move", { moves: [{ from: "a", to: "" }] }),
  call("os.fs.list", {}),
  call("os.fs.list", { path: "" }),
  call("os.fs.grep", {}),
  call("os.fs.grep", { path: "src", glob: "*.ts" }),
  call("os.fs.grep", { pattern: "" }),
  call("os.fs.glob", {}),
  call("os.fs.glob", { pattern: "" }),
  call("os.fs.glob", { pattern: [] }),
  call("os.fs.glob", { pattern: ["*.ts", ""] }),
  call("os.web.search", {}),
  call("os.web.search", { query: "" }),
  call("os.web.fetch", {}),
  call("os.web.fetch", { url: "" }),
  call("os.http.request", { method: "GET" }),
  call("os.http.request", { url: "" }),
  call("skill.view", {}),
  call("skill.view", { name: "" }),
  call("tool.view", {}),
  call("tool.view", { name: "" }),
  // ATO-558: a search needs words to search for.
  call("tool.search", {}),
  call("tool.search", { query: "" }),
  call("tool.search", { limit: 3 }),
  call("memory.notes.store", {}),
  call("memory.notes.store", { content: "" }),
  call("memory.notes.store", { tags: ["x"] }),
  call("memory.notes.recall", {}),
  call("memory.notes.recall", { k: 3 }),
];

const MORE_ACCEPTED = [
  call("os.fs.edit", { path: "a.ts", oldString: "foo", newString: "bar" }),
  call("os.fs.edit", { path: "a.ts", oldString: "debug();\n", newString: "" }),
  call("os.fs.edit", { path: "App.tsx", oldString: "<div>", newString: "<section>", replaceAll: true }),
  call("os.fs.move", { from: "C:\\Users\\me\\Q1 report.pdf", to: "C:\\Users\\me\\Reports 2026\\" }),
  call("os.fs.move", { from: "a", to: "b", overwrite: true }),
  call("os.fs.move", { moves: [{ from: "a.pdf", to: "Docs/" }, { from: "b.jpg", to: "Images/" }] }),
  // The ATO-899 alias shapes still reach `fs-move-aliases.ts`.
  call("os.fs.move", { paths: ["archive (4).zip"], destination: "Archives/archive (4).zip" }),
  call("os.fs.move", { source: "a.txt", dest: "b.txt" }),
  call("os.fs.move", { src: "a.txt", target: "b/" }),
  call("os.fs.move", { sources: "[\"a\",\"b\"]", destination: "Docs" }),
  call("os.fs.list", { path: "." }),
  call("os.fs.list", { path: "src", kind: "file", extensions: ["ts"], maxEntries: 50 }),
  call("os.fs.grep", { pattern: "foo", glob: ["*.ts"], outputMode: "files_with_matches" }),
  call("os.fs.grep", { pattern: "a|b", literal: true }),
  call("os.fs.glob", { pattern: "**/*.ts", limit: 50 }),
  call("os.fs.glob", { pattern: ["**/*.ts", "*.md"] }),
  call("os.web.search", { query: "llama.cpp grammar", maxResults: 5 }),
  call("os.web.fetch", { url: "https://example.com/a", extractMode: "text" }),
  call("os.http.request", { url: "https://api.example.com", method: "POST", headers: { A: "b" }, body: { a: 1 } }),
  call("skill.view", { name: "pdf" }),
  call("tool.view", { name: "os.git.show" }),
  call("tool.search", { query: "send slack message" }),
  call("tool.search", { query: "calendar event", limit: 5 }),
  call("memory.notes.store", { content: "Prefer pnpm", tags: ["prefs", "tooling"] }),
  call("memory.notes.recall", { query: "pnpm", k: 3 }),
  call("memory.notes.recall", { query: "" }),
  call("memory.notes.recall", { id: 42 }),
  // Tools without a branch keep the generic object.
  call("os.fs.hash", { path: "a" }),
  call("skill.run_script", {}),
  call("memory.notes.forget", { id: 1 }),
];

/** Tool and branch rule, in the order of the `tool-call` rule. */
const NEW_BRANCHES: ReadonlyArray<[string, string]> = [
  ["os.fs.edit", "fs-edit-call"],
  ["os.fs.move", "fs-move-call"],
  ["os.fs.list", "fs-list-call"],
  ["os.fs.grep", "fs-grep-call"],
  ["os.fs.glob", "fs-glob-call"],
  ["os.web.search", "web-search-call"],
  ["os.web.fetch", "web-fetch-call"],
  ["os.http.request", "http-request-call"],
  ["skill.view", "skill-view-call"],
  ["tool.view", "tool-view-call"],
  ["tool.search", "tool-search-call"],
  ["memory.notes.store", "notes-store-call"],
  ["memory.notes.recall", "notes-recall-call"],
];

const allGrammars = async (): Promise<Array<[string, string]>> => {
  const plain = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
  const qwen = withoutReasoningPrelude(await buildGrammar(QWEN_THINK_PROFILE));
  const gemma = withoutReasoningPrelude(await buildGrammar(GEMMA4_THINK_PROFILE));
  const names = [
    ...NEW_BRANCHES.map(([tool]) => tool),
    "os.fs.hash",
    "skill.run_script",
    "memory.notes.forget",
  ];
  return [
    ["plain", plain],
    ["qwen", qwen],
    ["gemma", gemma],
    ["plain per-request", buildGrammarForTools(plain, names)],
    ["qwen per-request", buildGrammarForTools(qwen, names)],
  ];
};

describe("the tools small models use most need their required args (ATO-1114)", () => {
  it("rejects empty or incomplete args and accepts every shape the tools accept", async () => {
    for (const [id, grammar] of await allGrammars()) {
      for (const bad of MORE_REJECTED) expect(gbnfAccepts(grammar, "root", bad), `${id} ${bad}`).toBe(false);
      for (const good of MORE_ACCEPTED) expect(gbnfAccepts(grammar, "root", good), `${id} ${good}`).toBe(true);
    }
  });

  it("the static grammar file names none of them through the generic branch", async () => {
    const grammar = await readFile(GRAMMAR_FILE, "utf8");
    const toolCall = grammar.split("\n").find((l) => l.startsWith("tool-call ::=")) ?? "";
    for (const [, rule] of NEW_BRANCHES) expect(toolCall, rule).toContain(` ${rule} `);
    const nameRules = grammar
      .split("\n")
      .filter((l) => /^(os|discovery|memory)-tool ::=/.test(l))
      .join("\n");
    for (const name of ['"fs.edit"', '"fs.move"', '"fs.list"', '"fs.grep"', '"fs.glob"', '"web.search"', '"web.fetch"', '"http.request"', '"view"', "tool.view", "tool.search", '"notes.store"', '"notes.recall"']) {
      expect(nameRules, name).not.toContain(name);
    }
    // Their neighbours stay on the generic branch.
    for (const name of ['"fs.hash"', '"fs.restore"', "skill.run_script", '"notes.forget"']) {
      expect(nameRules, name).toContain(name);
    }
  });

  it("lets a required value open on `<` but keeps every `<|` out under a reasoning profile", async () => {
    for (const profile of [QWEN_THINK_PROFILE, GEMMA4_THINK_PROFILE]) {
      const g = await buildGrammar(profile);
      for (const good of ['"<div>"', '"<b"', '" |> Enum.map(f)"', '"\\n|> f"']) {
        expect(gbnfAccepts(g, "required-string", good), `${profile.id} ${good}`).toBe(true);
      }
      for (const bad of ['"<|im_start|>"', '"<<|"', '"x|>"', '"||>"', '""']) {
        expect(gbnfAccepts(g, "required-string", bad), `${profile.id} ${bad}`).toBe(false);
      }
      const edit = (oldString: string): string => JSON.stringify({ path: "a.tsx", oldString, newString: "x" });
      expect(gbnfAccepts(g, "fs-edit-args", edit("<div>")), profile.id).toBe(true);
      expect(gbnfAccepts(g, "fs-edit-args", edit("<|channel>")), profile.id).toBe(false);
    }
  });

  it("per-request narrowing drops each branch its request does not admit", async () => {
    const base = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    for (const [tool, rule] of NEW_BRANCHES) {
      const kept = buildGrammarForTools(base, [tool, "os.fs.hash"]);
      expect(kept, tool).toMatch(new RegExp(`^tool-call ::= reply-call \\| ${rule} \\| other-call$`, "m"));
      expect(grammarToolNames(kept), tool).toEqual([tool, "os.fs.hash", "reply"].sort());
      const dropped = buildGrammarForTools(base, ["os.fs.hash"]);
      expect(dropped, tool).not.toMatch(new RegExp(`^tool-call ::= .*\\b${rule}\\b`, "m"));
      const sample = MORE_ACCEPTED.find((c) => c.startsWith(`[{"tool":"${tool}"`))!;
      expect(gbnfAccepts(kept, "root", sample), tool).toBe(true);
      expect(gbnfAccepts(dropped, "root", sample), tool).toBe(false);
    }
  });

  it("a whole coding session's set keeps every branch in rule order, with no generic branch", async () => {
    const base = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const tools = ["os.shell.run", "os.fs.read", "os.fs.write", ...NEW_BRANCHES.map(([tool]) => tool)];
    const g = buildGrammarForTools(base, tools);
    const rules = ["shell-call", "fs-read-call", "fs-write-call", ...NEW_BRANCHES.map(([, rule]) => rule)];
    expect(g).toContain(`tool-call ::= reply-call | ${rules.join(" | ")}\n`);
    expect(grammarToolNames(g)).toEqual([...tools, "reply"].sort());
  });
});
