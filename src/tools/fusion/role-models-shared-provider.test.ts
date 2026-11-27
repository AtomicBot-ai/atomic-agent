import { describe, expect, it } from "vitest";

import type { FusionRoleModels } from "../../llm/run-mode/index.js";
import type { DelegateTask } from "./delegate-args.js";
import { allowedModels, legKey, resolveTaskLegs } from "./role-models.js";

// The worker leg and two roles all on one cloud entry, a model each.
const worker = { providerId: "openrouter", model: "qwen/qwen3.8-27b", turnModel: "qwen/qwen3.8-27b" };
const roles: FusionRoleModels = {
  byRole: {
    review: { providerId: "openrouter", model: "deepseek/deepseek-v4.1", turnModel: "deepseek/deepseek-v4.1", local: false },
    plan: { providerId: "openrouter", model: "anthropic/claude-opus-5.5", turnModel: "anthropic/claude-opus-5.5", local: false },
    explore: { providerId: "openrouter", model: "qwen/qwen3.8-27b", turnModel: "qwen/qwen3.8-27b", local: false },
  },
  mixLocalModels: false,
  localLegProviderIds: [],
};

function task(id: string, over: Partial<DelegateTask> = {}): DelegateTask {
  return { id, title: id, instructions: "do it", ...over };
}

describe("role models on one shared provider entry", () => {
  it("lists every model of the shared entry, each once", () => {
    expect(allowedModels(worker, roles)).toEqual([
      { providerId: "openrouter", model: "qwen/qwen3.8-27b" },
      { providerId: "openrouter", model: "deepseek/deepseek-v4.1" },
      { providerId: "openrouter", model: "anthropic/claude-opus-5.5" },
    ]);
  });

  it("runs a role with its own model on a leg of its own, not on the workers' model", () => {
    const legs = resolveTaskLegs(
      [task("r", { role: "review" }), task("p", { model: "anthropic/claude-opus-5.5" }), task("e", { role: "explore" })],
      worker,
      roles,
    );
    expect(legs.get("r")).toEqual({
      providerId: "openrouter",
      model: "deepseek/deepseek-v4.1",
      turnModel: "deepseek/deepseek-v4.1",
      isWorkerLeg: false,
      role: "review",
    });
    expect(legs.get("p")?.turnModel).toBe("anthropic/claude-opus-5.5");
    expect(legs.get("p")?.isWorkerLeg).toBe(false);
    // The same provider and model as the workers is the worker leg.
    expect(legs.get("e")?.isWorkerLeg).toBe(true);
    expect(legs.get("e")?.role).toBe("explore");
  });

  it("keys two models of one provider as two legs", () => {
    expect(legKey({ providerId: "openrouter", turnModel: "a" })).not.toBe(
      legKey({ providerId: "openrouter", turnModel: "b" }),
    );
    expect(legKey({ providerId: "openrouter" })).toBe(legKey({ providerId: "openrouter" }));
  });
});
