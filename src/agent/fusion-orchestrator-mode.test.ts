import { describe, expect, it } from "vitest";
import {
  checkFusionOrchestrator,
  emptyFusionOrchestratorState,
  recordDelegation,
  refusalFor,
} from "./fusion-orchestrator-mode.js";

/** The two facts the gate reads off a tool: does it exist, does it mutate. */
function registryWith(
  tools: Record<string, { readonly: boolean }>,
): { get: (n: string) => { readonly: boolean }; has: (n: string) => boolean } {
  return {
    has: (name) => name in tools,
    get: (name) => {
      const tool = tools[name];
      if (!tool) throw new Error(`unknown tool ${name}`);
      return tool;
    },
  };
}

const REGISTRY = registryWith({
  "mcp.notion.search": { readonly: true },
  "os.fs.read": { readonly: true },
  "os.fs.write": { readonly: false },
  "os.shell.run": { readonly: false },
  "fusion.delegate": { readonly: false },
  reply: { readonly: false },
  finish: { readonly: false },
});

const BEFORE = emptyFusionOrchestratorState();
/** One fan-out done, however it went. */
const AFTER = { delegations: 1 };

describe("the fusion orchestrator gate", () => {
  it("lets the orchestrator read while it is still planning", () => {
    // Planning *is* reading: a gate that blocked it would leave the
    // model choosing a split it has no basis for.
    expect(checkFusionOrchestrator("os.fs.read", REGISTRY, BEFORE).allowed).toBe(
      true,
    );
  });

  it("holds back the first mutation until the turn has delegated", () => {
    for (const tool of ["os.fs.write", "os.shell.run"]) {
      const verdict = checkFusionOrchestrator(tool, REGISTRY, BEFORE);
      expect(verdict.allowed).toBe(false);
      expect(verdict.refusal?.status).toBe("error");
      // The exit matters more than the veto: a bare refusal reads as a
      // broken tool and gets retried.
      expect(verdict.refusal?.summary).toContain("fusion.delegate");
      expect(verdict.refusal?.details).toMatchObject({
        fusion_orchestrator: true,
        delegations: 0,
      });
    }
  });

  it("never gates the fan-out itself", () => {
    // The one call the refusal points at cannot be the one it blocks.
    expect(
      checkFusionOrchestrator("fusion.delegate", REGISTRY, BEFORE).allowed,
    ).toBe(true);
  });

  it("never gates the terminal verbs", () => {
    // Vetoing `reply` would veto the turn's own exit — the mistake
    // plan mode documents and avoids for the same reason.
    for (const tool of ["reply", "finish"]) {
      expect(checkFusionOrchestrator(tool, REGISTRY, BEFORE).allowed).toBe(true);
    }
  });

  it("stays shut after a fan-out, whatever came back", () => {
    // The failure this gate was rewritten for, twice. First a latch that
    // opened on any completed fan-out; then an escape for tasks returned
    // `needs_orchestrator`, which at approval level 1 was FOUR of six
    // tasks — the escape became the main road and thirteen writes went
    // through it. There is no circumstance now.
    for (const tool of ["os.fs.write", "os.shell.run"]) {
      const verdict = checkFusionOrchestrator(tool, REGISTRY, AFTER);
      expect(verdict.allowed).toBe(false);
      expect(verdict.refusal?.summary).toContain("Send it out again");
    }
  });

  it("tells a blocked task to come back with its paths named", () => {
    // `needs_orchestrator` now means "the operator did not authorise
    // that directory", and the answer is another fan-out whose brief
    // names the paths, so the prompt can offer the right scope.
    const verdict = checkFusionOrchestrator("os.fs.write", REGISTRY, AFTER);
    expect(verdict.refusal?.summary).toContain("needs_orchestrator");
    expect(verdict.refusal?.summary).toContain("files");
  });

  it("does not take an MCP tool's word for being read-only", () => {
    // `readonly` on an MCP descriptor is the server's own
    // `readOnlyHint` / `destructiveHint` — third-party wire data. A
    // server could opt itself out of the rule by shipping one flag.
    expect(
      checkFusionOrchestrator("mcp.notion.search", REGISTRY, BEFORE).allowed,
    ).toBe(false);
    expect(
      checkFusionOrchestrator("mcp.notion.search", REGISTRY, AFTER).allowed,
    ).toBe(false);
  });

  it("passes an unknown tool through untouched", () => {
    // The executor's unknown-tool path has the better message, and
    // answering "delegate first" to a typo sends the model hunting for
    // the wrong problem.
    expect(
      checkFusionOrchestrator("os.fs.wirte", REGISTRY, BEFORE).allowed,
    ).toBe(true);
  });

  it("names the tool it refused", () => {
    const refusal = refusalFor("os.fs.write", BEFORE);
    expect(refusal.tool).toBe("os.fs.write");
    expect(refusal.summary).toContain("`os.fs.write`");
  });
});

describe("recordDelegation", () => {
  it("counts fan-outs and unlocks nothing", () => {
    // The result used to be inspected for `needs_orchestrator` tasks.
    // Nothing in it can open the gate now, so nothing is read out of it.
    let state = recordDelegation(emptyFusionOrchestratorState());
    expect(state).toEqual({ delegations: 1 });
    state = recordDelegation(state);
    expect(state).toEqual({ delegations: 2 });
    expect(
      checkFusionOrchestrator("os.fs.write", REGISTRY, state).allowed,
    ).toBe(false);
  });
});
