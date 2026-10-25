import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildMcpToolNameRule } from "../../mcp/mcp-grammar-builder.js";
import type { McpToolMeta } from "../../mcp/mcp-types.js";
import { GEMMA4_THINK_PROFILE, PLAIN_INSTRUCT_PROFILE } from "../model-profile.js";
import { buildGrammar, buildGrammarForTools } from "./build-grammar.js";
import { gbnfAccepts } from "./gbnf-test-helpers.js";
import { withoutReasoningPrelude } from "./reasoning-prelude.js";

const GRAMMAR_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../grammars/tool-call.gbnf");

const call = (tool: string): string => JSON.stringify([{ tool, args: {} }]);
const meta = (server: string, rawName: string): McpToolMeta => ({
  server,
  rawName,
  qualifiedName: `mcp.${server}.${rawName}`,
  description: "",
  inputSchema: { type: "object" },
  resourceClass: "approval_gated",
});

/**
 * With no MCP tools the static placeholder (`mcp.<any>.<any>`) let a
 * grammar-constrained local model invent `mcp.example.toolkit`, and the
 * turn died on "tool not registered" (ATO-1029). Now no per-server MCP
 * name is admitted until the runtime stitches in the real list.
 */
describe("mcp.* tool names follow the MCP catalog (ATO-1029)", () => {
  it("admits no per-server MCP name when there are no MCP tools", async () => {
    const file = await readFile(GRAMMAR_FILE, "utf8");
    const plain = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const gemma = withoutReasoningPrelude(await buildGrammar(GEMMA4_THINK_PROFILE));
    const empty = await buildGrammar(PLAIN_INSTRUCT_PROFILE, undefined, { mcpToolNameRule: buildMcpToolNameRule([]) });
    for (const [id, g] of [["file", file], ["plain", plain], ["gemma", gemma], ["empty catalog", empty]] as const) {
      expect(gbnfAccepts(g, "root", call("mcp.example.toolkit")), id).toBe(false);
      expect(gbnfAccepts(g, "root", call("mcp.github.create_issue")), id).toBe(false);
      // The native discovery tools are a separate rule and stay.
      expect(gbnfAccepts(g, "root", call("mcp.resource.list")), id).toBe(true);
    }
    expect(plain).toBe(file);
  });

  it("admits exactly the registered names when MCP tools exist", async () => {
    const rule = buildMcpToolNameRule([meta("github", "create_issue"), meta("docs", "search")]);
    for (const profile of [PLAIN_INSTRUCT_PROFILE, GEMMA4_THINK_PROFILE]) {
      const g = withoutReasoningPrelude(await buildGrammar(profile, undefined, { mcpToolNameRule: rule }));
      expect(gbnfAccepts(g, "root", call("mcp.github.create_issue")), profile.id).toBe(true);
      expect(gbnfAccepts(g, "root", call("mcp.docs.search")), profile.id).toBe(true);
      expect(gbnfAccepts(g, "root", call("mcp.example.toolkit")), profile.id).toBe(false);
      expect(gbnfAccepts(g, "root", call("mcp.resource.list")), profile.id).toBe(true);
      // Same tool-name rule as before ATO-1029 whenever MCP tools exist.
      expect(g, profile.id).toMatch(/^tool-name ::= .*\| mcp-native-tool \| mcp-server-tool \| "\\"finish\\""$/m);
    }
  });

  it("the browser switch and the MCP rule compose", async () => {
    const rule = buildMcpToolNameRule([meta("docs", "search")]);
    const g = await buildGrammar(PLAIN_INSTRUCT_PROFILE, undefined, { mcpToolNameRule: rule, browserEnabled: false });
    expect(g).not.toMatch(/^tool-name ::= .*browser-tool/m);
    expect(gbnfAccepts(g, "root", call("mcp.docs.search"))).toBe(true);
  });

  it("per-request narrowing admits only the names it lists, MCP ones included", async () => {
    const rule = buildMcpToolNameRule([meta("docs", "search")]);
    const base = await buildGrammar(PLAIN_INSTRUCT_PROFILE, undefined, { mcpToolNameRule: rule });
    const g = buildGrammarForTools(base, ["mcp.docs.search", "os.fs.list"]);
    expect(gbnfAccepts(g, "root", call("mcp.docs.search"))).toBe(true);
    expect(gbnfAccepts(g, "root", call("mcp.example.toolkit"))).toBe(false);
    const none = buildGrammarForTools(await buildGrammar(PLAIN_INSTRUCT_PROFILE), ["os.fs.list"]);
    expect(gbnfAccepts(none, "root", call("mcp.example.toolkit"))).toBe(false);
  });
});
