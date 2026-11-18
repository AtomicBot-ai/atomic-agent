import { describe, expect, it } from "vitest";

import {
  MAX_PROFILE_DESCRIPTION_CHARS,
  MAX_PROFILE_PROMPT_CHARS,
  MAX_PROFILE_TOOLS,
} from "../agent-profiles/agent-profile.js";
import { parseAgentProfilesConfig } from "./agent-profiles-schema.js";
import { ConfigValidationError } from "./config-validation-error.js";

const FIELD = "llm.runMode.agentProfiles";

describe("parseAgentProfilesConfig (ATO-1667)", () => {
  it("parses a valid map, trimming text and dropping unknown fields", () => {
    expect(
      parseAgentProfilesConfig(
        {
          reviewer: {
            description: "  Reads a change and reports problems ",
            prompt: "\n  Find bugs. Report file and line.\n",
            model: " review ",
            tools: ["os.fs.read", " Grep ", "os.fs.read", ""],
            color: "red",
          },
          "Code_Explorer-2": { prompt: "Find code." },
        },
        FIELD,
      ),
    ).toEqual({
      reviewer: {
        description: "Reads a change and reports problems",
        prompt: "Find bugs. Report file and line.",
        model: "review",
        tools: ["os.fs.read", "Grep"],
      },
      "code_explorer-2": { prompt: "Find code." },
    });
  });

  it("reads an empty map as no profiles, and absent or null as unset", () => {
    expect(parseAgentProfilesConfig({}, FIELD)).toEqual({});
    expect(parseAgentProfilesConfig(undefined, FIELD)).toBeUndefined();
    expect(parseAgentProfilesConfig(null, FIELD)).toBeUndefined();
  });

  it("treats an empty tools list as no allowlist, as a profile file does", () => {
    expect(parseAgentProfilesConfig({ a: { prompt: "x", tools: [] } }, FIELD)).toEqual({
      a: { prompt: "x" },
    });
  });

  it.each([["has space"], ["-leading-dash"], ["plugin:agent"], [""], ["a".repeat(65)]])(
    "rejects the profile name %j with the field path",
    (name) => {
      const run = () => parseAgentProfilesConfig({ [name]: { prompt: "x" } }, FIELD);
      expect(run).toThrow(ConfigValidationError);
      expect(run).toThrow(`${FIELD}.${name}: profile name must be`);
    },
  );

  it("rejects two keys that lower-case to the same name", () => {
    expect(() =>
      parseAgentProfilesConfig({ Review: { prompt: "x" }, review: { prompt: "y" } }, FIELD),
    ).toThrow(/duplicate profile name: review/);
  });

  it("rejects an over-long description at the file's limit", () => {
    const ok = "d".repeat(MAX_PROFILE_DESCRIPTION_CHARS);
    expect(parseAgentProfilesConfig({ a: { prompt: "x", description: ok } }, FIELD)).toEqual({
      a: { prompt: "x", description: ok },
    });
    expect(() =>
      parseAgentProfilesConfig({ a: { prompt: "x", description: `${ok}d` } }, FIELD),
    ).toThrow(`${FIELD}.a.description: longer than ${MAX_PROFILE_DESCRIPTION_CHARS} chars`);
  });

  it("requires a prompt and bounds it at the file's body limit", () => {
    expect(() => parseAgentProfilesConfig({ a: {} }, FIELD)).toThrow(`${FIELD}.a.prompt`);
    expect(() => parseAgentProfilesConfig({ a: { prompt: "   " } }, FIELD)).toThrow(
      `${FIELD}.a.prompt`,
    );
    expect(() =>
      parseAgentProfilesConfig({ a: { prompt: "p".repeat(MAX_PROFILE_PROMPT_CHARS + 1) } }, FIELD),
    ).toThrow(`at most ${MAX_PROFILE_PROMPT_CHARS}`);
  });

  it("rejects wrong field types with the field path", () => {
    expect(() => parseAgentProfilesConfig({ a: { prompt: "x", description: 3 } }, FIELD)).toThrow(
      `${FIELD}.a.description`,
    );
    expect(() => parseAgentProfilesConfig({ a: { prompt: "x", model: "  " } }, FIELD)).toThrow(
      `${FIELD}.a.model`,
    );
    expect(() => parseAgentProfilesConfig({ a: { prompt: "x", tools: "Read, Grep" } }, FIELD)).toThrow(
      `${FIELD}.a.tools`,
    );
    expect(() => parseAgentProfilesConfig({ a: { prompt: "x", tools: [1] } }, FIELD)).toThrow(
      `${FIELD}.a.tools`,
    );
    const many = Array.from({ length: MAX_PROFILE_TOOLS + 1 }, (_, i) => `t${i}`);
    expect(() => parseAgentProfilesConfig({ a: { prompt: "x", tools: many } }, FIELD)).toThrow(
      `more than ${MAX_PROFILE_TOOLS} entries`,
    );
  });

  it.each([["a string"], [["review"]], [3], [true]])("rejects a non-object map %j", (raw) => {
    expect(() => parseAgentProfilesConfig(raw, FIELD)).toThrow(
      `${FIELD}: expected an object keyed by profile name`,
    );
  });

  it.each([["text"], [["x"]], [null], [7]])("rejects a non-object entry %j", (entry) => {
    expect(() => parseAgentProfilesConfig({ a: entry }, FIELD)).toThrow(
      `${FIELD}.a: expected an object`,
    );
  });
});
