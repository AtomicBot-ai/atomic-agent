import { describe, expect, it } from "vitest";

import { buildGrammar } from "../../llm/grammar/build-grammar.js";
import { gbnfAccepts } from "../../llm/grammar/gbnf-test-helpers.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../../prompt/tool-descriptors.js";
import type { ToolDescriptor } from "../../prompt/stable-prefix.js";
import type { StepDependencies } from "./step-contract.js";
import { resolveStepGrammar } from "./step-inference.js";

const call = (tool: string, args: unknown): string => JSON.stringify([{ tool, args }]);

async function deps(): Promise<Pick<StepDependencies, "registry" | "isFusionOrchestrator" | "grammar">> {
  return {
    grammar: await buildGrammar(PLAIN_INSTRUCT_PROFILE),
    registry: undefined as unknown as StepDependencies["registry"],
  };
}

/** `localModels.strictToolArgs` (ATO-633) reaches the request grammar through `resolveStepGrammar`. */
describe("resolveStepGrammar with localModels.strictToolArgs (ATO-633)", () => {
  it("off: an unrestricted step sends the base grammar byte-identical", async () => {
    const d = await deps();
    expect(resolveStepGrammar({}, d, DEFAULT_TOOL_DESCRIPTORS, false, false)).toBe(d.grammar);
  });

  it("on: the step's descriptors hold their tools' args to the schemas", async () => {
    const d = await deps();
    const grammar = resolveStepGrammar({}, d, DEFAULT_TOOL_DESCRIPTORS, false, true);
    expect(grammar).not.toBe(d.grammar);
    expect(gbnfAccepts(d.grammar, "root", call("os.git.log", { oneline: true }))).toBe(true);
    expect(gbnfAccepts(grammar, "root", call("os.git.log", { oneline: true }))).toBe(false);
    expect(gbnfAccepts(grammar, "root", call("os.git.log", { repo: "." }))).toBe(true);
  });

  it("on, final step: reply and finish only, finish held to its schema", async () => {
    const d = await deps();
    const grammar = resolveStepGrammar({ terminalOnly: true }, d, DEFAULT_TOOL_DESCRIPTORS, false, true);
    expect(gbnfAccepts(grammar, "root", call("finish", { summary: "done" }))).toBe(true);
    expect(gbnfAccepts(grammar, "root", call("finish", { verdict: "done" }))).toBe(false);
    expect(gbnfAccepts(grammar, "root", call("os.git.log", {}))).toBe(false);
    expect(gbnfAccepts(grammar, "root", call("reply", { text: "ok" }))).toBe(true);
  });

  it("on: a descriptor's own schema (an MCP tool's inputSchema) wins over the built-in one", async () => {
    const d = await deps();
    const descriptors: ToolDescriptor[] = DEFAULT_TOOL_DESCRIPTORS.map((desc) =>
      desc.name === "os.git.status"
        ? { ...desc, argsJsonSchema: { type: "object", properties: { only: { type: "boolean" } }, additionalProperties: false } }
        : desc,
    );
    const grammar = resolveStepGrammar({}, d, descriptors, false, true);
    expect(gbnfAccepts(grammar, "root", call("os.git.status", { only: true }))).toBe(true);
    expect(gbnfAccepts(grammar, "root", call("os.git.status", { repo: "." }))).toBe(false);
  });
});
