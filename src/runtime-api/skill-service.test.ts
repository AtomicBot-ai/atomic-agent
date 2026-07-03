import { describe, expect, it, vi } from "vitest";

import type { SkillRecord } from "../skills/index.js";

import { RuntimeApiError } from "./runtime-api-error.js";
import {
  computeNextDisabled,
  installSkillFromPath,
  listSkills,
  type SkillServiceDeps,
} from "./skill-service.js";

function fakeRecord(name: string): SkillRecord {
  return {
    manifest: {
      name,
      description: `desc ${name}`,
      version: "1.0.0",
      requiresTools: [],
      requiresScripts: [],
      dangerous: false,
    },
    rootDir: `/skills/${name}`,
    manifestPath: `/skills/${name}/SKILL.md`,
    source: "global",
  } as SkillRecord;
}

function makeDeps(overrides: Partial<SkillServiceDeps> = {}): SkillServiceDeps {
  return {
    skillRegistry: {
      listAll: vi.fn(() => [
        { record: fakeRecord("alpha"), disabled: false },
        { record: fakeRecord("beta"), disabled: true },
      ]),
      errors: vi.fn(() => []),
      setDisabledNames: vi.fn(),
    },
    refreshSkills: vi.fn(async () => undefined),
    config: {
      paths: {
        userConfigFile: "/tmp/config.json",
        globalSkillsDir: "/skills",
        projectSkillsDirName: ".atomic-agent/skills",
      },
    },
    capabilities: { workingDir: "/tmp/proj" },
    ...overrides,
  };
}

describe("computeNextDisabled", () => {
  it("adds a name when disabling", () => {
    expect(computeNextDisabled(["a"], "b", true)).toEqual(["a", "b"]);
  });

  it("removes a name when enabling", () => {
    expect(computeNextDisabled(["a", "b"], "a", false)).toEqual(["b"]);
  });

  it("returns null when already in the target state", () => {
    expect(computeNextDisabled(["a"], "a", true)).toBeNull();
    expect(computeNextDisabled(["a"], "b", false)).toBeNull();
  });

  it("keeps the list sorted", () => {
    expect(computeNextDisabled(["c", "a"], "b", true)).toEqual(["a", "b", "c"]);
  });
});

describe("skill-service listSkills", () => {
  it("returns all skills including disabled with a disabled flag", () => {
    const deps = makeDeps();
    const { skills } = listSkills(deps);
    expect(skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(skills.find((s) => s.name === "beta")?.disabled).toBe(true);
  });
});

describe("skill-service installSkillFromPath", () => {
  it("rejects a missing sourcePath before touching disk", async () => {
    const deps = makeDeps();
    await expect(
      installSkillFromPath(deps, { sourcePath: "" }),
    ).rejects.toBeInstanceOf(RuntimeApiError);
    expect(deps.refreshSkills).not.toHaveBeenCalled();
  });
});
