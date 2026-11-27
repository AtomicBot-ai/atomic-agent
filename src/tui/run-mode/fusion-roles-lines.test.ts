import { describe, expect, it } from "vitest";

import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { describeFusionRole, describeFusionRoles } from "./fusion-roles-lines.js";

const rm = {
  workerModel: "qwen-14b",
  roles: {
    byRole: {
      review: { providerId: "openrouter", model: "deepseek/deepseek-v4.1", local: false },
    },
    mixLocalModels: false,
    localLegProviderIds: [],
  },
} as unknown as ResolvedRunMode;

describe("fusion role lines", () => {
  it("names the model and the provider of a set role", () => {
    expect(describeFusionRole(rm, "review")).toBe("review: deepseek/deepseek-v4.1 on openrouter");
  });

  it("says where an unset role runs", () => {
    expect(describeFusionRole(rm, "build")).toBe(
      "build: not set, its tasks run on the workers' model qwen-14b",
    );
  });

  it("lists every role and how to set one", () => {
    const text = describeFusionRoles(rm);
    for (const role of ["plan", "build", "review", "explore", "utility"]) {
      expect(text).toContain(`  ${role}: `);
    }
    expect(text).toContain("/runmode role <role> <provider> [model]");
  });
});
