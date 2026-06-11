import { describe, expect, it } from "vitest";

import { listAgentAdapters } from "./index.js";

describe("agent adapters", () => {
  it("registers three adapters", () => {
    const ids = listAgentAdapters().map((a) => a.id);
    expect(ids).toEqual(["atomic-agent", "hermes", "openclaw"]);
  });

  it("atomic-agent reports missing llama URL when unset", () => {
    const prev = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL;
    delete process.env.ATOMIC_AGENT_EVAL_LLAMA_URL;
    try {
      const atomic = listAgentAdapters(["atomic-agent"])[0];
      expect(atomic?.probeRequirements().length).toBeGreaterThan(0);
    } finally {
      if (prev !== undefined) process.env.ATOMIC_AGENT_EVAL_LLAMA_URL = prev;
    }
  });
});
