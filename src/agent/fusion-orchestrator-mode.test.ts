import { describe, expect, it } from "vitest";
import {
  checkFusionOrchestrator,
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
  "os.fs.read": { readonly: true },
  "os.fs.write": { readonly: false },
  "os.shell.run": { readonly: false },
  "fusion.delegate": { readonly: false },
  reply: { readonly: false },
  finish: { readonly: false },
});

const BEFORE = { delegated: false };
const AFTER = { delegated: true };

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
        delegated: false,
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

  it("opens up once the workers have reported", () => {
    // Integration is the orchestrator's own job, and so is anything a
    // worker had to hand up for approval. Both are writes.
    for (const tool of ["os.fs.write", "os.shell.run"]) {
      expect(checkFusionOrchestrator(tool, REGISTRY, AFTER).allowed).toBe(true);
    }
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
    const refusal = refusalFor("os.fs.write");
    expect(refusal.tool).toBe("os.fs.write");
    expect(refusal.summary).toContain("`os.fs.write`");
  });
});
