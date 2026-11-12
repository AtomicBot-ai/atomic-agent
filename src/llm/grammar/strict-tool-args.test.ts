import { describe, expect, it } from "vitest";

import { buildMcpToolNameRule } from "../../mcp/mcp-grammar-builder.js";
import type { McpToolMeta } from "../../mcp/mcp-types.js";
import { getDefaultArgsJsonSchema } from "../../prompt/default-tool-args-schemas.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../../prompt/tool-descriptors.js";
import {
  GEMMA4_THINK_PROFILE,
  PLAIN_INSTRUCT_PROFILE,
  QWEN_THINK_PROFILE,
} from "../model-profile.js";
import { buildGrammar, buildGrammarForTools } from "./build-grammar.js";
import { gbnfAccepts, parseGbnf } from "./gbnf-test-helpers.js";
import { withoutReasoningPrelude } from "./reasoning-prelude.js";
import {
  applyStrictToolArgs,
  STRICT_CALL_RULE,
  type StrictArgsTool,
} from "./strict-tool-args.js";

const call = (tool: string, args: unknown): string => JSON.stringify([{ tool, args }]);
const tool = (name: string): StrictArgsTool => ({ name, schema: getDefaultArgsJsonSchema(name) });
const ALL_TOOLS: StrictArgsTool[] = DEFAULT_TOOL_DESCRIPTORS.map((d) => ({
  name: d.name,
  schema: d.argsJsonSchema,
}));

describe("strict tool args (ATO-633): the generic branch", () => {
  it("leaves the grammar byte-identical with no schemas, and with no tool it admits", async () => {
    const plain = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    expect(applyStrictToolArgs(plain, [])).toBe(plain);
    expect(applyStrictToolArgs(plain, [{ name: "os.git.log", schema: undefined }])).toBe(plain);
    expect(applyStrictToolArgs(plain, [tool("os.git.log")].map((t) => ({ ...t, name: "not.a.tool" })))).toBe(plain);
  });

  it("holds an admitted tool's args to its schema and takes it out of tool-name", async () => {
    const plain = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const strict = applyStrictToolArgs(plain, [tool("os.git.log"), tool("browser.tabs")]);
    parseGbnf(strict);
    expect(strict).toMatch(new RegExp(`^tool-call ::= .*\\| ${STRICT_CALL_RULE} \\| other-call$`, "m"));
    // Gone from the grouped sub-rules, the rest of them intact.
    expect(strict).not.toMatch(/^os-tool ::= .*"git\.log"/m);
    expect(strict).toMatch(/^os-tool ::= .*"git\.status"/m);
    expect(strict).not.toMatch(/^browser-tool ::= .*"tabs"/m);
    expect(strict).toMatch(/^browser-tool ::= .*"navigate"/m);

    expect(gbnfAccepts(strict, "root", call("os.git.log", { repo: ".", limit: 5 }))).toBe(true);
    expect(gbnfAccepts(strict, "root", call("os.git.log", {}))).toBe(true);
    // An invented key: legal before, impossible now.
    expect(gbnfAccepts(plain, "root", call("os.git.log", { repo: ".", oneline: true }))).toBe(true);
    expect(gbnfAccepts(strict, "root", call("os.git.log", { repo: ".", oneline: true }))).toBe(false);
    // A missing required key and an out-of-enum value.
    expect(gbnfAccepts(plain, "root", call("browser.tabs", {}))).toBe(true);
    expect(gbnfAccepts(strict, "root", call("browser.tabs", {}))).toBe(false);
    expect(gbnfAccepts(strict, "root", call("browser.tabs", { action: "open" }))).toBe(false);
    expect(gbnfAccepts(strict, "root", call("browser.tabs", { action: "switch", index: 1 }))).toBe(true);
    // Tools it did not touch keep the any-object rule.
    expect(gbnfAccepts(strict, "root", call("os.git.status", { anything: [1] }))).toBe(true);
    // A batch mixes both branches.
    expect(
      gbnfAccepts(strict, "root", JSON.stringify([
        { tool: "os.git.log", args: { repo: "." } },
        { tool: "os.git.status", args: {} },
        { tool: "reply", args: { text: "done" } },
      ])),
    ).toBe(true);
  });

  it("does not touch reply or the dedicated branches", async () => {
    const plain = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const strict = applyStrictToolArgs(plain, ["reply", "os.shell.run", "os.fs.read", "os.fs.move"].map(tool));
    expect(strict).toBe(plain);
    const withOthers = applyStrictToolArgs(plain, ALL_TOOLS);
    for (const rule of ["reply-call", "shell-call", "fs-read-call", "fs-move-call"]) {
      expect(withOthers.match(new RegExp(`^${rule} ::= .*$`, "m"))?.[0]).toBe(
        plain.match(new RegExp(`^${rule} ::= .*$`, "m"))?.[0],
      );
    }
    // The shell branch still takes its free-form extra keys, the move aliases still open.
    expect(gbnfAccepts(withOthers, "root", call("os.shell.run", { cmd: "ls", extra: 1 }))).toBe(true);
    expect(gbnfAccepts(withOthers, "root", call("os.fs.move", { paths: ["a"], destination: "b" }))).toBe(true);
    expect(gbnfAccepts(withOthers, "root", call("reply", { text: "ok" }))).toBe(true);
  });

  it("falls back per tool: an unconvertible schema keeps that tool on the any-object path", async () => {
    const plain = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const strict = applyStrictToolArgs(plain, [
      tool("os.git.log"),
      { name: "os.git.status", schema: { type: "object", properties: { a: { type: "date" } } } },
      { name: "os.git.diff", schema: { type: "object", properties: { n: { $ref: "#/$defs/n" } }, $defs: { n: { $ref: "#/$defs/n" } } } },
      { name: "os.git.show", schema: { type: "object" } },
      {
        name: "os.git.blame",
        schema: {
          type: "object",
          properties: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, { type: "string" }])),
          additionalProperties: false,
        },
      },
    ]);
    parseGbnf(strict);
    expect(gbnfAccepts(strict, "root", call("os.git.log", { bogus: 1 }))).toBe(false);
    for (const name of ["os.git.status", "os.git.diff", "os.git.show", "os.git.blame"]) {
      expect(strict, name).toMatch(new RegExp(`^os-tool ::= .*"${name.slice(3).replace(".", "\\.")}"`, "m"));
      expect(gbnfAccepts(strict, "root", call(name, { anything: 1 })), name).toBe(true);
    }
  });

  it("converts every built-in tool on the generic branch, and the result parses", async () => {
    const plain = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const strict = applyStrictToolArgs(plain, ALL_TOOLS);
    parseGbnf(strict);
    const cases: Array<[string, unknown, boolean]> = [
      ["fusion.delegate", { tasks: [{ id: "a", instructions: "x", maxSteps: 3 }], maxWorkers: 2 }, true],
      ["fusion.delegate", { tasks: [{ id: "a" }] }, false],
      ["fusion.delegate", { tasks: [{ id: "a", instructions: "x", maxSteps: 0 }] }, false],
      ["verify.run", { kind: "command", cmd: "ls", args: ["-l"] }, true],
      ["verify.run", { cmd: "ls" }, false],
      ["plan.update", { items: [{ step: "a", status: "done" }] }, true],
      ["plan.update", { items: [{ step: "a", status: "later" }] }, false],
      ["os.fs.read_document", { path: "a", format: "text" }, false],
      ["memory.profile.list", {}, true],
      ["memory.profile.list", { a: 1 }, false],
      ["os.fs.archive.extract", { path: "a", destDir: "b", limits: { maxEntries: 3, other: 1 } }, true],
      ["browser.scroll", { direction: "up", amount: "page" }, true],
      ["browser.scroll", { direction: "up", amount: 3 }, true],
      ["vision.describe", { prompt: "p", paths: ["a", "b", "c", "d"] }, true],
      ["vision.describe", { prompt: "p", paths: ["a", "b", "c", "d", "e"] }, false],
      ["finish", { summary: "done" }, true],
      ["finish", { result: "done" }, false],
    ];
    for (const [name, args, want] of cases) {
      expect(gbnfAccepts(strict, "root", call(name, args)), `${name} ${JSON.stringify(args)}`).toBe(want);
    }
  });

  it("is deterministic and cached", async () => {
    const plain = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const a = applyStrictToolArgs(plain, ALL_TOOLS);
    const b = applyStrictToolArgs(plain, [...ALL_TOOLS].reverse());
    expect(b).toBe(a);
  });
});

describe("strict tool args (ATO-633): with the rest of the grammar pipeline", () => {
  it("after narrowing: only the admitted names, and other-call goes when every one is strict", async () => {
    const plain = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const narrowed = buildGrammarForTools(plain, ["os.git.log", "finish", "os.fs.read"]);
    const strict = applyStrictToolArgs(narrowed, ALL_TOOLS);
    parseGbnf(strict);
    expect(strict).toMatch(/^tool-call ::= reply-call \| fs-read-call \| strict-args-call$/m);
    expect(gbnfAccepts(strict, "root", call("os.git.log", { repo: "." }))).toBe(true);
    expect(gbnfAccepts(strict, "root", call("finish", { summary: "s" }))).toBe(true);
    expect(gbnfAccepts(strict, "root", call("finish", { reason: "s" }))).toBe(false);
    expect(gbnfAccepts(strict, "root", call("os.git.status", {}))).toBe(false);
    expect(gbnfAccepts(strict, "root", call("os.fs.read", { path: "a" }))).toBe(true);
  });

  it("keeps a narrowed name with no schema on the any-object path", async () => {
    const plain = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const narrowed = buildGrammarForTools(plain, ["os.git.log", "custom.tool"]);
    const strict = applyStrictToolArgs(narrowed, ALL_TOOLS);
    expect(strict).toMatch(/^tool-name ::= "\\"custom\.tool\\""$/m);
    expect(gbnfAccepts(strict, "root", call("custom.tool", { any: 1 }))).toBe(true);
    expect(gbnfAccepts(strict, "root", call("os.git.log", { any: 1 }))).toBe(false);
  });

  it("holds an MCP tool to its server's inputSchema", async () => {
    const meta: McpToolMeta = {
      server: "gh",
      rawName: "create_issue",
      qualifiedName: "mcp.gh.create_issue",
      description: "",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, labels: { type: "array", items: { type: "string" } } },
        required: ["title"],
      },
      resourceClass: "approval_gated",
    };
    const plain = await buildGrammar(PLAIN_INSTRUCT_PROFILE, undefined, {
      mcpToolNameRule: buildMcpToolNameRule([meta, { ...meta, rawName: "other", qualifiedName: "mcp.gh.other" }]),
    });
    const strict = applyStrictToolArgs(plain, [{ name: meta.qualifiedName, schema: meta.inputSchema }]);
    parseGbnf(strict);
    expect(strict).toMatch(/^mcp-server-tool ::= "\\"mcp\.gh\.other\\""$/m);
    expect(gbnfAccepts(strict, "root", call("mcp.gh.create_issue", { title: "t", labels: ["bug"] }))).toBe(true);
    expect(gbnfAccepts(strict, "root", call("mcp.gh.create_issue", { body: "b" }))).toBe(false);
    expect(gbnfAccepts(strict, "root", call("mcp.gh.other", { body: "b" }))).toBe(true);
  });

  it("generated strings go through the reasoning profiles' marker guard (F37)", async () => {
    for (const profile of [GEMMA4_THINK_PROFILE, QWEN_THINK_PROFILE]) {
      const base = withoutReasoningPrelude(await buildGrammar(profile));
      const strict = applyStrictToolArgs(base, [tool("os.git.log")]);
      parseGbnf(strict);
      expect(gbnfAccepts(strict, "root", call("os.git.log", { repo: "a|b <c>" })), profile.id).toBe(true);
      expect(gbnfAccepts(strict, "root", call("os.git.log", { repo: "<|channel>x" })), profile.id).toBe(false);
      // The pipe operator after a space stays legal (ATO-800).
      expect(gbnfAccepts(strict, "root", call("os.git.log", { path: "x |> f" })), profile.id).toBe(true);
    }
  });

  it("keeps the reasoning prelude root", async () => {
    const qwen = await buildGrammar(QWEN_THINK_PROFILE);
    const strict = applyStrictToolArgs(qwen, [tool("os.git.log")]);
    expect(strict.match(/^root ::= .*$/m)?.[0]).toBe(qwen.match(/^root ::= .*$/m)?.[0]);
    expect(gbnfAccepts(strict, "tool-call-array", call("os.git.log", { bogus: 1 }))).toBe(false);
  });
});
