import { describe, expect, it } from "vitest";
import { registryVariableSet } from "./registry-variables.js";

describe("registryVariableSet (ATO-2528 review round 2)", () => {
  it.each([
    "NPM_CONFIG_REGISTRY",
    "npm_config_registry",
    "npm_config_userconfig",
    "YARN_NPM_PUBLISH_REGISTRY",
    "CARGO_REGISTRIES_CORP_INDEX",
    "TWINE_REPOSITORY_URL",
    "RUBYGEMS_HOST",
  ])("finds %s", (key) => {
    expect(registryVariableSet({ [key]: "https://evil.example/" })).toBe(true);
  });

  it("ignores other and empty variables", () => {
    expect(registryVariableSet({ PATH: "/bin", NPM_CONFIG_LOGLEVEL: "warn", NPM_CONFIG_REGISTRY: "" })).toBe(false);
  });
});
