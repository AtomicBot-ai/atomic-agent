import { describe, expect, it } from "vitest";

import { withFusionRolePin } from "./fusion-role-pin.js";

describe("withFusionRolePin", () => {
  it("pins a role to a shared provider with its own model", () => {
    expect(
      withFusionRolePin(
        { workers: 2, roles: { plan: "openrouter" } },
        "review",
        { providerId: "openrouter", model: "deepseek/deepseek-v4.1" },
      ),
    ).toEqual({
      workers: 2,
      roles: { plan: "openrouter", review: "openrouter" },
      roleModels: { review: "deepseek/deepseek-v4.1" },
    });
  });

  it("drops the old model when the role moves without a new one", () => {
    expect(
      withFusionRolePin(
        { roles: { review: "openrouter" }, roleModels: { review: "deepseek/deepseek-v4.1" } },
        "review",
        { providerId: "or-coder" },
      ),
    ).toEqual({ roles: { review: "or-coder" } });
  });

  it("clears a role and leaves no empty maps", () => {
    expect(
      withFusionRolePin(
        { workers: 3, roles: { review: "openrouter" }, roleModels: { review: "x" } },
        "review",
        null,
      ),
    ).toEqual({ workers: 3 });
  });
});
