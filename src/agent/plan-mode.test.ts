import { describe, expect, it } from "vitest";
import { checkPlanMode } from "./plan-mode.js";
import { ToolRegistry, type ToolDefinition } from "../tools/tool-registry.js";

function tool(name: string, readonly: boolean): ToolDefinition {
  return {
    name,
    description: name,
    readonly,
    async run() {
      return {
        tool: name,
        status: "ok" as const,
        summary: "",
        details: {},
        truncated: false,
      };
    },
  };
}

function registryWith(...tools: ToolDefinition[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const definition of tools) registry.register(definition);
  return registry;
}

describe("checkPlanMode", () => {
  const registry = registryWith(
    tool("os.fs.read", true),
    tool("os.fs.grep", true),
    tool("os.web.search", true),
    tool("os.fs.write", false),
    tool("os.shell.run", false),
    tool("os.fs.trash", false),
  );

  it("lets every read-only tool through", () => {
    // Most of what planning *is*: the agent has to read the code before
    // it can say what it would change.
    for (const name of ["os.fs.read", "os.fs.grep", "os.web.search"]) {
      expect(checkPlanMode(name, registry).allowed, name).toBe(true);
    }
  });

  it("refuses every mutating tool", () => {
    for (const name of ["os.fs.write", "os.shell.run", "os.fs.trash"]) {
      expect(checkPlanMode(name, registry).allowed, name).toBe(false);
    }
  });

  it("never touches the terminal verbs", () => {
    // `reply` and `finish` are how the plan reaches the operator. A mode
    // whose purpose is to produce a plan cannot block the sentence that
    // delivers it — and vetoing a terminal verb vetoes the turn's exit.
    const bare = new ToolRegistry();
    for (const name of ["reply", "finish"]) {
      expect(checkPlanMode(name, bare).allowed, name).toBe(true);
    }
  });

  it("lets an unknown tool through to the executor's own error", () => {
    // Answering "not in plan mode" to a typo would send the model
    // hunting for a mode switch instead of a spelling mistake.
    expect(checkPlanMode("os.fs.raed", registry).allowed).toBe(true);
  });

  it("tells the model what to do instead of just saying no", () => {
    // The part that decides whether plan mode works at all. A bare "not
    // permitted" reads as a broken tool, and a model that thinks its
    // tools are broken retries them.
    const refusal = checkPlanMode("os.fs.write", registry).refusal;
    expect(refusal?.status).toBe("error");
    expect(refusal?.summary).toContain("plan mode is on");
    expect(refusal?.summary).toContain("os.fs.write");
    expect(refusal?.summary).toContain("reply with the plan");
    expect(refusal?.details).toMatchObject({ plan_mode: true });
  });
});
