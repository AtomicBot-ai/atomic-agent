import { describe, expect, it } from "vitest";

import type { FusionRoleModels } from "../../llm/run-mode/index.js";
import type { DelegateTask } from "./delegate-args.js";
import { allowedModels, resolveTaskLegs, unknownModels } from "./role-models.js";

const worker = { providerId: "local-llama", model: "qwen-14b" };
const roles: FusionRoleModels = {
  byRole: {
    build: { providerId: "or-coder", model: "qwen-coder", local: false },
    review: { providerId: "or-sonnet", model: "sonnet", local: false },
    utility: { providerId: "small-llama", model: "qwen3-8b", local: true },
  },
  mixLocalModels: false,
  localLegProviderIds: ["local-llama"],
};

function task(id: string, over: Partial<DelegateTask> = {}): DelegateTask {
  return { id, title: id, instructions: "do it", ...over };
}

describe("models by role (ATO-943)", () => {
  it("allows the worker leg and every role model, each provider once", () => {
    expect(allowedModels(worker, roles)).toEqual([
      { providerId: "local-llama", model: "qwen-14b" },
      { providerId: "or-coder", model: "qwen-coder" },
      { providerId: "or-sonnet", model: "sonnet" },
      { providerId: "small-llama", model: "qwen3-8b" },
    ]);
    expect(allowedModels(worker, undefined)).toEqual([worker]);
  });

  it("rejects a model outside the list, by model name or provider id", () => {
    expect(
      unknownModels([task("a", { model: "sonnet" }), task("b", { model: "or-coder" })], worker, roles),
    ).toBeUndefined();
    const refusal = unknownModels([task("a", { model: "gpt-9" })], worker, roles);
    expect(refusal).toContain('task "a" names model "gpt-9"');
    expect(refusal).toContain("`qwen-14b`, `qwen-coder`, `sonnet`, `qwen3-8b`");
    // Without roles only the worker leg is allowed.
    expect(unknownModels([task("a", { model: "sonnet" })], worker, undefined)).toBeDefined();
    expect(unknownModels([task("a", { model: "qwen-14b" })], worker, undefined)).toBeUndefined();
  });

  it("resolves explicit model, then role, then the worker leg", () => {
    const legs = resolveTaskLegs(
      [
        task("m", { model: "sonnet", role: "build" }),
        task("r", { role: "build" }),
        task("d"),
        task("w", { model: "qwen-14b" }),
      ],
      worker,
      roles,
    );
    expect(legs.get("m")).toMatchObject({ providerId: "or-sonnet", isWorkerLeg: false });
    expect(legs.get("m")?.role).toBeUndefined();
    expect(legs.get("r")).toMatchObject({ providerId: "or-coder", model: "qwen-coder", role: "build" });
    expect(legs.get("d")).toEqual({ providerId: "local-llama", model: "qwen-14b", isWorkerLeg: true });
    expect(legs.get("w")).toMatchObject({ isWorkerLeg: true });
  });

  it("notes a role with no model of its own, only when roles are configured", () => {
    expect(resolveTaskLegs([task("e", { role: "explore" })], worker, roles).get("e")?.note).toContain(
      "role explore has no model configured",
    );
    expect(resolveTaskLegs([task("e", { role: "explore" })], worker, undefined).get("e")).toEqual({
      providerId: "local-llama",
      model: "qwen-14b",
      isWorkerLeg: true,
    });
  });

  it("guards a second local model unless the machine is marked to hold both", () => {
    const guarded = resolveTaskLegs([task("u", { role: "utility" })], worker, roles).get("u");
    expect(guarded).toMatchObject({ providerId: "local-llama", isWorkerLeg: true });
    expect(guarded?.note).toContain("mixLocalModels");
    const mixed = resolveTaskLegs(
      [task("u", { role: "utility" })],
      worker,
      { ...roles, mixLocalModels: true },
    ).get("u");
    expect(mixed).toMatchObject({ providerId: "small-llama", isWorkerLeg: false, role: "utility" });
  });

  it("lets one extra local model in when the session holds none, and guards a different second one", () => {
    const cloudWorker = { providerId: "or-worker", model: "flash" };
    const twoLocal: FusionRoleModels = {
      byRole: {
        utility: { providerId: "small-llama", model: "qwen3-8b", local: true },
        explore: { providerId: "other-llama", model: "gemma", local: true },
      },
      mixLocalModels: false,
      localLegProviderIds: [],
    };
    const legs = resolveTaskLegs(
      [task("u", { role: "utility" }), task("u2", { role: "utility" }), task("e", { role: "explore" })],
      cloudWorker,
      twoLocal,
    );
    expect(legs.get("u")?.providerId).toBe("small-llama");
    expect(legs.get("u2")?.providerId).toBe("small-llama");
    expect(legs.get("e")).toMatchObject({ providerId: "or-worker", isWorkerLeg: true });
    expect(legs.get("e")?.note).toContain("second local model");
  });

  it("treats a role pinned to the worker leg as the worker leg", () => {
    const sameLeg: FusionRoleModels = {
      ...roles,
      byRole: { utility: { providerId: "local-llama", model: "qwen-14b", local: true } },
    };
    expect(resolveTaskLegs([task("u", { role: "utility" })], worker, sameLeg).get("u")).toEqual({
      providerId: "local-llama",
      model: "qwen-14b",
      isWorkerLeg: true,
      role: "utility",
    });
  });
});
