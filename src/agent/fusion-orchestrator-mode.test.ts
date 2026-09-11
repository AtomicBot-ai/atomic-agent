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
/** One fan-out done, nothing handed up — the observed failure case. */
const AFTER_EMPTY = { delegations: 1, handedUp: 0 };
/** A worker stopped on an approval it cannot request. */
const AFTER_HANDED_UP = { delegations: 1, handedUp: 1 };

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

  it("stays shut after a fan-out that handed nothing up", () => {
    // The failure this gate was rewritten for: a fan-out came back with
    // one task `needs_orchestrator` and two `cancelled`, and the old
    // latch let the orchestrator write fifteen files. A delegation that
    // was merely attempted is not a licence to do the work.
    for (const tool of ["os.fs.write", "os.shell.run"]) {
      const verdict = checkFusionOrchestrator(tool, REGISTRY, AFTER_EMPTY);
      expect(verdict.allowed).toBe(false);
      expect(verdict.refusal?.summary).toContain("send it out again");
    }
  });

  it("opens only for work a worker handed up", () => {
    // The one thing the orchestrator has that the workers do not is a
    // person to ask. `needs_orchestrator` is a worker saying it hit an
    // approval it cannot request.
    for (const tool of ["os.fs.write", "os.shell.run"]) {
      expect(
        checkFusionOrchestrator(tool, REGISTRY, AFTER_HANDED_UP).allowed,
      ).toBe(true);
    }
  });

  it("does not take an MCP tool's word for being read-only", () => {
    // `readonly` on an MCP descriptor is the server's own
    // `readOnlyHint` / `destructiveHint` — third-party wire data. A
    // server could opt itself out of the rule by shipping one flag.
    expect(
      checkFusionOrchestrator("mcp.notion.search", REGISTRY, BEFORE).allowed,
    ).toBe(false);
    expect(
      checkFusionOrchestrator("mcp.notion.search", REGISTRY, AFTER_HANDED_UP)
        .allowed,
    ).toBe(true);
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
  function result(statuses: string[]) {
    return {
      tool: "fusion.delegate",
      status: "ok" as const,
      summary: "",
      details: { tasks: statuses.map((status, i) => ({ id: `t${i}`, status })) },
      truncated: false,
    };
  }

  it("counts the tasks a worker handed up, not the fan-outs", () => {
    // `fusion.delegate` returns ok even when every worker failed —
    // partial results are the value of a fan-out — so the count that
    // matters is per task, and only one status means "a worker could
    // not do this because it has no person to ask".
    const after = recordDelegation(
      emptyFusionOrchestratorState(),
      result(["ok", "cancelled", "needs_orchestrator", "failed"]),
    );
    expect(after).toEqual({ delegations: 1, handedUp: 1 });
  });

  it("reads a fan-out where everything failed as nothing handed up", () => {
    const after = recordDelegation(
      emptyFusionOrchestratorState(),
      result(["cancelled", "cancelled", "failed"]),
    );
    expect(after).toEqual({ delegations: 1, handedUp: 0 });
  });

  it("survives a result with no task list at all", () => {
    // A refusal, a malformed result, a compressed error: the ledger
    // still advances its fan-out count and unlocks nothing.
    const after = recordDelegation(emptyFusionOrchestratorState(), {
      tool: "fusion.delegate",
      status: "error",
      summary: "not fusion",
      details: {},
      truncated: false,
    });
    expect(after).toEqual({ delegations: 1, handedUp: 0 });
  });

  it("accumulates across fan-outs", () => {
    let state = recordDelegation(emptyFusionOrchestratorState(), result(["ok"]));
    state = recordDelegation(state, result(["needs_orchestrator"]));
    expect(state).toEqual({ delegations: 2, handedUp: 1 });
  });
});
