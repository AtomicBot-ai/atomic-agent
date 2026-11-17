import { describe, expect, it } from "vitest";

import { ConfigValidationError } from "../config-validation-error.js";
import { parseUserConfigFile, USER_CONFIG_DEFAULTS } from "../config-schema.js";
import { parsePersonasConfig, PERSONA_TEXT_MAX_CHARS } from "./persona-config.js";

describe("agent.personas", () => {
  it("is absent from the defaults and from a file without it", () => {
    expect(USER_CONFIG_DEFAULTS.agent.personas).toBeUndefined();
    expect(parseUserConfigFile({}).agent.personas).toBeUndefined();
    expect("personas" in parseUserConfigFile({ agent: {} }).agent).toBe(false);
  });

  it("reads definitions, bindings and the active name", () => {
    const parsed = parseUserConfigFile({
      agent: {
        personas: {
          active: "reviewer",
          projects: { "/work/site": "writer" },
          definitions: {
            reviewer: { instructions: "  Review for bugs first. ", style: "Terse." },
            writer: { instructions: "Plain English." },
          },
        },
      },
    });
    expect(parsed.agent.personas).toEqual({
      active: "reviewer",
      projects: { "/work/site": "writer" },
      definitions: {
        reviewer: { instructions: "Review for bugs first.", style: "Terse." },
        writer: { instructions: "Plain English." },
      },
    });
  });

  it("fills missing maps and keeps a name with no definition", () => {
    expect(parsePersonasConfig({ active: "later" })).toEqual({
      active: "later",
      projects: {},
      definitions: {},
    });
    expect(parsePersonasConfig({ active: null })).toEqual({ projects: {}, definitions: {} });
  });

  it("refuses a wrong shape", () => {
    expect(() => parsePersonasConfig("reviewer")).toThrow(ConfigValidationError);
    expect(() => parsePersonasConfig({ definitions: [] })).toThrow(ConfigValidationError);
    expect(() => parsePersonasConfig({ definitions: { a: { instructions: "" } } })).toThrow(ConfigValidationError);
    expect(() => parsePersonasConfig({ definitions: { a: { instructions: "x", style: 3 } } })).toThrow(ConfigValidationError);
    expect(() => parsePersonasConfig({ definitions: { "has space": { instructions: "x" } } })).toThrow(ConfigValidationError);
    expect(() => parsePersonasConfig({ active: 5 })).toThrow(ConfigValidationError);
    expect(() => parsePersonasConfig({ projects: { "/a": "bad name" } })).toThrow(ConfigValidationError);
  });

  it("reserves `default` and bounds the text", () => {
    expect(() => parsePersonasConfig({ definitions: { default: { instructions: "x" } } })).toThrow(/reserved/);
    expect(() =>
      parsePersonasConfig({ definitions: { long: { instructions: "x".repeat(PERSONA_TEXT_MAX_CHARS + 1) } } }),
    ).toThrow(/at most/);
  });
});
