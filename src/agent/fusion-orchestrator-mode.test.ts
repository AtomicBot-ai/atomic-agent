import { describe, expect, it } from "vitest";
import type { ApprovalGate } from "../approval/approval-gate.js";
import { buildVerifyRunTool, verifySyntaxTool } from "../tools/verify/index.js";
import {
  checkFusionOrchestrator,
  delegationProducedWork,
  emptyFusionOrchestratorState,
  recordDelegation,
  refusalFor,
  refusedToolNames,
  wouldRefuse,
} from "./fusion-orchestrator-mode.js";

/** The flag as the shipped definition carries it; the gate never runs the tool here. */
const verifyRunReadonly = buildVerifyRunTool({
  approvals: {} as ApprovalGate,
  approvalRequired: false,
  config: {
    browser: {
      enabled: false,
      channel: "chrome",
      headless: true,
      cdpUrl: null,
      executablePath: null,
      noSandbox: false,
      launchTimeoutMs: 1_000,
    },
  },
}).readonly;

/** The two facts the gate reads off a tool: does it exist, does it mutate. */
function registryWith(tools: Record<string, { readonly: boolean }>): {
  get: (n: string) => { readonly: boolean };
  has: (n: string) => boolean;
} {
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
    expect(
      checkFusionOrchestrator("os.fs.read", REGISTRY, BEFORE).allowed,
    ).toBe(true);
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

  it("lets the orchestrator verify — read-only checks are review, not building (D1)", () => {
    // The real definitions, not a fixture: the gate reads `readonly`
    // off the registry, so this pins the flag the tools actually ship.
    const registry = registryWith({
      "verify.syntax": { readonly: verifySyntaxTool.readonly },
      "verify.run": { readonly: verifyRunReadonly },
    });
    for (const tool of ["verify.syntax", "verify.run"]) {
      expect(checkFusionOrchestrator(tool, registry, BEFORE).allowed).toBe(
        true,
      );
      expect(checkFusionOrchestrator(tool, registry, AFTER).allowed).toBe(true);
    }
  });

  it("never gates the terminal verbs", () => {
    // Vetoing `reply` would veto the turn's own exit — the mistake
    // plan mode documents and avoids for the same reason.
    for (const tool of ["reply", "finish"]) {
      expect(checkFusionOrchestrator(tool, REGISTRY, BEFORE).allowed).toBe(
        true,
      );
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
    // The result is read for one thing only — whether anything ran —
    // and that still opens no gate.
    let state = recordDelegation(emptyFusionOrchestratorState());
    expect(state).toEqual({ delegations: 1, barrenDelegations: 0 });
    state = recordDelegation(state);
    expect(state).toEqual({ delegations: 2, barrenDelegations: 0 });
    expect(
      checkFusionOrchestrator("os.fs.write", REGISTRY, state).allowed,
    ).toBe(false);
  });

  it("counts a fan-out where nothing ran, and forgets it once one does", () => {
    let state = recordDelegation(emptyFusionOrchestratorState(), false);
    expect(state.barrenDelegations).toBe(1);
    state = recordDelegation(state, false);
    expect(state.barrenDelegations).toBe(2);
    // Any wave that executes something clears the run: the leg is alive
    // and the next failure is about the work, not the plumbing.
    state = recordDelegation(state, true);
    expect(state.barrenDelegations).toBe(0);
  });
});

describe("delegationProducedWork — did the fan-out run anything", () => {
  const task = (stepCount: number) => ({ id: "t", stepCount });

  it("is false only when every task executed zero steps", () => {
    expect(delegationProducedWork({ details: { tasks: [task(0)] } })).toBe(
      false,
    );
    expect(
      delegationProducedWork({ details: { tasks: [task(0), task(0)] } }),
    ).toBe(false);
    expect(
      delegationProducedWork({ details: { tasks: [task(0), task(3)] } }),
    ).toBe(true);
  });

  it("calls anything it cannot read work, so the old refusal stands", () => {
    expect(delegationProducedWork({})).toBe(true);
    expect(delegationProducedWork({ details: {} })).toBe(true);
    expect(delegationProducedWork({ details: { tasks: [] } })).toBe(true);
    expect(delegationProducedWork({ details: { tasks: "nope" } })).toBe(true);
    expect(delegationProducedWork({ details: { tasks: [{}] } })).toBe(true);
  });
});

describe("the refusal after a run of fan-outs that ran nothing", () => {
  it("stops asking for another one and names the leg", () => {
    let state = emptyFusionOrchestratorState();
    state = recordDelegation(state, false);
    // One barren fan-out is what pressing Esc looks like — still rework.
    expect(refusalFor("os.fs.write", state).summary).toContain(
      "fusion.delegate",
    );
    expect(refusalFor("os.fs.write", state).summary).not.toContain(
      "zero steps",
    );

    state = recordDelegation(state, false);
    const summary = refusalFor("os.fs.write", state).summary;
    expect(summary).toContain("zero steps");
    expect(summary).toContain("worker leg is not serving");
    expect(summary).toContain("Stop here and tell the operator");
    // It must not also tell the model to re-delegate — that is the loop.
    expect(summary).not.toContain("Send it out again");
  });

  it("goes back to asking for a rework once a wave runs", () => {
    let state = emptyFusionOrchestratorState();
    state = recordDelegation(state, false);
    state = recordDelegation(state, false);
    state = recordDelegation(state, true);
    expect(refusalFor("os.fs.write", state).summary).toContain(
      "Send it out again",
    );
  });
});

describe("wouldRefuse / refusedToolNames — the gate's verdict ahead of dispatch", () => {
  const CTX = { registry: REGISTRY };

  it("answers exactly what checkFusionOrchestrator would, before anything is emitted", () => {
    for (const tool of Object.keys({
      "mcp.notion.search": 1,
      "os.fs.read": 1,
      "os.fs.write": 1,
      "os.shell.run": 1,
      "fusion.delegate": 1,
      reply: 1,
      finish: 1,
      "os.fs.wirte": 1,
    })) {
      expect(wouldRefuse(tool, CTX), tool).toBe(
        !checkFusionOrchestrator(tool, REGISTRY, BEFORE).allowed,
      );
      // The ledger shapes the refusal text only, never the verdict.
      expect(wouldRefuse(tool, CTX), tool).toBe(
        !checkFusionOrchestrator(tool, REGISTRY, AFTER).allowed,
      );
    }
  });

  it("refuses the mutating tools and every MCP tool; keeps reads, the fan-out, the terminals and unknown names", () => {
    const refused = refusedToolNames(
      [
        "os.fs.read",
        "os.fs.write",
        "os.shell.run",
        "mcp.notion.search",
        "fusion.delegate",
        "reply",
        "finish",
        "os.fs.wirte",
      ],
      CTX,
    );
    expect([...refused].sort()).toEqual([
      "mcp.notion.search",
      "os.fs.write",
      "os.shell.run",
    ]);
  });
});

describe("wouldRefuse (the shared predicate)", () => {
  // One predicate behind the dispatch gate, the batch trim and the
  // per-request grammar: if they disagreed, the trim could keep a call
  // the gate then refuses — which is exactly what happened in run 14.
  const ctx = { registry: REGISTRY };

  it("answers the same as the dispatch gate for every tool", () => {
    for (const tool of Object.keys({
      "mcp.notion.search": 0,
      "os.fs.read": 0,
      "os.fs.write": 0,
      "os.shell.run": 0,
      "fusion.delegate": 0,
      reply: 0,
      finish: 0,
      "os.fs.wirte": 0,
    })) {
      expect(wouldRefuse(tool, ctx)).toBe(
        !checkFusionOrchestrator(tool, REGISTRY, BEFORE).allowed,
      );
    }
  });

  it("never refuses the fan-out, the terminals, reads or unknown names", () => {
    expect(wouldRefuse("fusion.delegate", ctx)).toBe(false);
    expect(wouldRefuse("reply", ctx)).toBe(false);
    expect(wouldRefuse("finish", ctx)).toBe(false);
    expect(wouldRefuse("os.fs.read", ctx)).toBe(false);
    expect(wouldRefuse("os.fs.wirte", ctx)).toBe(false);
  });

  it("refuses mutations and every MCP tool, whatever it claims", () => {
    expect(wouldRefuse("os.fs.write", ctx)).toBe(true);
    expect(wouldRefuse("os.shell.run", ctx)).toBe(true);
    expect(wouldRefuse("mcp.notion.search", ctx)).toBe(true);
  });
});
